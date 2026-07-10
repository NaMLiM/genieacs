import test from "node:test";
import assert from "node:assert";
import { readdir, readFile } from "node:fs/promises";
import * as esbuild from "esbuild";
import * as acorn from "acorn";
import * as walk from "acorn-walk";

import { bundleViews, validateViewScript } from "../lib/bundle-views.ts";
import { Views } from "../lib/types.ts";

// Build a bundle in dev mode (no minify) so the emitted destructure and the
// __VG alias stay readable for inspection and instantiation.
async function bundle(scripts: Record<string, string>): Promise<string> {
  const views: Views = {};
  for (const [id, script] of Object.entries(scripts))
    views[id] = { md5: "", script };
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    return await bundleViews(views);
  } finally {
    process.env.NODE_ENV = prev;
  }
}

// Instantiate the emitted module against a synthetic viewGlobals, exercising the
// real binding mechanism: the import is dropped and __VG is supplied directly.
function instantiate(
  moduleText: string,
  vg: Record<string, unknown>,
): Record<string, (node: unknown) => unknown> {
  const body = moduleText
    .replace(/import\s*\{[^}]*\}\s*from\s*["'][^"']*["'];?/, "")
    .replace("export default", "return");
  return new Function("__VG", body)(vg) as Record<
    string,
    (node: unknown) => unknown
  >;
}

// Parse ui/view-globals.ts and read the exact set of allowlisted keys, so the
// seed audit below tracks the real runtime allowlist rather than a copy.
async function viewGlobalsKeys(): Promise<Set<string>> {
  const source = await readFile("ui/view-globals.ts", "utf8");
  const js = (await esbuild.transform(source, { loader: "ts" })).code;
  const ast = acorn.parse(js, { ecmaVersion: "latest", sourceType: "module" });
  const keys = new Set<string>();
  walk.simple(ast, {
    VariableDeclarator(node: any) {
      if (node.id?.name !== "viewGlobals") return;
      // export const viewGlobals = Object.freeze({ ... })
      let obj = node.init;
      if (obj?.type === "CallExpression") obj = obj.arguments[0];
      if (obj?.type !== "ObjectExpression") return;
      for (const prop of obj.properties)
        if (prop.key) keys.add(prop.key.name ?? prop.key.value);
    },
  });
  return keys;
}

// Extract the free identifiers a single view body destructures from __VG.
async function freeIdents(script: string): Promise<Set<string>> {
  const moduleText = await bundle({ v: script });
  const m = moduleText.match(/const \{([^}]*)\} = __VG;/);
  if (!m) return new Set();
  return new Set(
    m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

const SYNTHETIC_VG: Record<string, unknown> = {
  Math,
  JSON,
  h: (name: string, attrs: unknown, ...children: unknown[]) => ({
    name,
    attrs,
    children,
  }),
  Signal: function Signal() {},
  prompt: () => "P",
  confirm: () => true,
  clearTimeout: () => undefined,
  Date,
  window: Object.freeze({
    prompt: () => "WP",
    confirm: () => true,
  }),
};

void test("shield: blocked globals resolve to undefined, allowlisted work", async () => {
  const mod = await bundle({
    v: `return {
      document: typeof document,
      fetch: typeof fetch,
      mathMax: Math.max(2, 3),
      json: typeof JSON,
      wprompt: window.prompt(),
      wdoc: typeof window.document,
    };`,
  });
  const views = instantiate(mod, SYNTHETIC_VG);
  const res = views["v"](null) as Record<string, unknown>;
  assert.strictEqual(res.document, "undefined");
  assert.strictEqual(res.fetch, "undefined");
  assert.strictEqual(res.mathMax, 3);
  assert.strictEqual(res.json, "object");
  assert.strictEqual(res.wprompt, "WP");
  assert.strictEqual(res.wdoc, "undefined");
});

void test("shield: undeclared global write throws (strict + const binding)", async () => {
  const mod = await bundle({ v: `foo = 1; return foo;` });
  const views = instantiate(mod, SYNTHETIC_VG);
  assert.throws(() => views["v"](null), TypeError);
});

void test("shield: dead computed roots throw", async () => {
  for (const script of [
    `return globalThis["fetch"]();`,
    `return self["doc" + "ument"];`,
    `return frames[0];`,
  ]) {
    const mod = await bundle({ v: script });
    const views = instantiate(mod, SYNTHETIC_VG);
    assert.throws(
      () => views["v"](null),
      TypeError,
      `expected throw for: ${script}`,
    );
  }
});

void test("validator: rejects dynamic import() with location", async () => {
  const err = await validateViewScript("v", `const x = import("y");`);
  assert.strictEqual(
    err,
    "dynamic import() is not allowed in view scripts at v:1:10",
  );
});

void test("validator: rejects import.meta with location", async () => {
  const err = await validateViewScript("v", `return import.meta;`);
  assert.strictEqual(
    err,
    "import.meta is not allowed in view scripts at v:1:7",
  );
});

void test("validator: rejects async arrow functions with location", async () => {
  const err = await validateViewScript(
    "v",
    `const f = async () => 1; return f;`,
  );
  assert.match(
    err ?? "",
    /^async functions are not allowed in view scripts at v:\d+:\d+$/,
  );
});

void test("validator: rejects async function declarations", async () => {
  const err = await validateViewScript(
    "v",
    `async function f(){ await f(); } return f;`,
  );
  // The async function is the earliest rejected node (await is nested inside it).
  assert.match(err ?? "", /not allowed in view scripts at v:\d+:\d+$/);
});

void test("validator: accepts ordinary (non-async) functions", async () => {
  const err = await validateViewScript(
    "v",
    `function f(){ return 1; } return f();`,
  );
  assert.strictEqual(err, null);
});

void test("validator: accepts new.target (not import.meta)", async () => {
  const err = await validateViewScript(
    "v",
    `function f(){ return new.target; } return f();`,
  );
  assert.strictEqual(err, null);
});

void test("validator: rejects the reserved alias with location", async () => {
  const err = await validateViewScript("v", `return __VG;`);
  assert.strictEqual(
    err,
    "reserved identifier __VG is not allowed in view scripts at v:1:7",
  );
});

void test("validator: static import is a syntax error with location", async () => {
  const err = await validateViewScript("v", `import x from "y"; return x;`);
  assert.match(err ?? "", /at v:\d+:\d+$/);
});

void test("validator: accepts a valid view", async () => {
  const err = await validateViewScript(
    "v",
    `return <div>{Math.max(1, 2)}</div>;`,
  );
  assert.strictEqual(err, null);
});

void test("seed audit: every seed view's free idents are allowlisted", async () => {
  const keys = await viewGlobalsKeys();
  const seedFiles = (await readdir("seed")).filter((f) => f.endsWith(".jsx"));
  assert.ok(seedFiles.length > 0, "expected seed views");
  const union = new Set<string>();
  for (const file of seedFiles) {
    const script = await readFile(`seed/${file}`, "utf8");
    const idents = await freeIdents(script);
    for (const name of idents) {
      union.add(name);
      assert.ok(
        keys.has(name),
        `seed/${file} references non-allowlisted global: ${name}`,
      );
    }
  }
  // Guards the target:esnext requirement: the only transform-introduced free
  // identifier is the JSX factory h — a downlevel helper would surface here.
  assert.ok(union.has("h"));
});
