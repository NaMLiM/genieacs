import esbuild, { type TransformFailure } from "esbuild";
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import detectGlobals from "acorn-globals";

import { APP_JS } from "../build/assets.ts";
import { mapPosition } from "./source-map.ts";
import { Views } from "./types.ts";

// The allowlist is imported under this alias and each body destructures its free
// identifiers from it. A body referencing it is rejected (collision guard below).
const RESERVED_ALIAS = "__VG";

// Carries a message preformatted as "<text>" or "<text> at <id>:<line>:<col>",
// so validateViewScript can surface it while letting unexpected errors throw.
class ViewScriptError extends Error {}

function formatError(
  text: string,
  id: string,
  line?: number,
  column?: number,
): ViewScriptError {
  if (line == null) return new ViewScriptError(text);
  return new ViewScriptError(`${text} at ${id}:${line}:${column}`);
}

// Compile one view body to its bundle entry, shared by bundleViews and
// validateViewScript: wrap so top-level return is legal, transpile JSX (target
// esnext so no downlevel helpers leak in as free identifiers), scan free
// identifiers to route through the allowlist, reject what static binding can't
// shield (import.meta, import(), the reserved alias), then prepend "use strict"
// and the destructure of this body's free identifiers from __VG.
//
// Locations are reported against the original script: the wrapper is one line, so
// mapPosition's 0-based original line already equals the 1-based script line.
async function compileView(id: string, script: string): Promise<string> {
  const wrapped = `function __view(node){\n${script}\n}`;

  let transformed: { code: string; map: string };
  try {
    transformed = await esbuild.transform(wrapped, {
      loader: "jsx",
      jsxFactory: "h",
      jsxFragment: '""',
      target: "esnext",
      sourcemap: true,
    });
  } catch (err) {
    const failure = err as TransformFailure;
    if (!failure.errors?.length) throw err;
    const e = failure.errors[0];
    // esbuild locations are against the wrapped source: -1 line for the wrapper.
    if (!e.location) throw formatError(e.text, id);
    throw formatError(e.text, id, e.location.line - 1, e.location.column);
  }

  const code = transformed.code;

  const mapNode = (node: acorn.Node): { line: number; column: number } => {
    const start = node.loc!.start;
    return mapPosition(transformed.map, start.line, start.column);
  };

  let ast: acorn.Program;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
    });
  } catch (err) {
    // Not expected after esbuild accepts the code, but never emit an unscanned
    // body: reject with the mapped location.
    const loc = (err as { loc?: { line: number; column: number } }).loc;
    const text = (err as Error).message.replace(/\s*\(\d+:\d+\)\s*$/, "");
    if (!loc) throw formatError(text, id);
    const m = mapPosition(transformed.map, loc.line, loc.column);
    throw formatError(text, id, m.line, m.column);
  }

  // Reject import.meta, dynamic import(), and async/await, reporting the earliest
  // occurrence. async/await is forbidden because the cleanup owner is only
  // re-established for the synchronous extent of a handler/timer callback; a
  // microtask continuation after `await` runs with no owner, stranding any
  // listener/timer/signal it spawns (see ui/view-membrane.ts).
  const rejections: { text: string; node: acorn.Node }[] = [];
  const rejectAsync = (node: acorn.Node): void => {
    if ((node as { async?: boolean }).async)
      rejections.push({
        text: "async functions are not allowed in view scripts",
        node,
      });
  };
  walk.simple(ast, {
    ImportExpression(node) {
      rejections.push({
        text: "dynamic import() is not allowed in view scripts",
        node,
      });
    },
    MetaProperty(node) {
      // MetaProperty also covers new.target (legal and harmless inside the
      // wrapper); only import.meta is rejected.
      if ((node as { meta?: { name?: string } }).meta?.name !== "import")
        return;
      rejections.push({
        text: "import.meta is not allowed in view scripts",
        node,
      });
    },
    FunctionDeclaration: rejectAsync,
    FunctionExpression: rejectAsync,
    ArrowFunctionExpression: rejectAsync,
    AwaitExpression(node) {
      // Top-level await is already a syntax error (the wrapper is non-async);
      // this catches `await` inside a script-defined async function.
      rejections.push({ text: "await is not allowed in view scripts", node });
    },
  });
  if (rejections.length) {
    const earliest = rejections.reduce((a, b) =>
      b.node.start < a.node.start ? b : a,
    );
    const m = mapNode(earliest.node);
    throw formatError(earliest.text, id, m.line, m.column);
  }

  // Free identifiers (excluding the `node` param and locals) — the names routed
  // through the allowlist. The analyzer's result is used verbatim: a missed one
  // would resolve to the real global.
  const globals = detectGlobals(ast);
  const freeIdents = globals.map((g) => g.name);

  // A body using the alias would emit `const { __VG } = __VG` (const TDZ); reject.
  const reserved = globals.find((g) => g.name === RESERVED_ALIAS);
  if (reserved) {
    const m = mapNode(reserved.nodes[0]);
    throw formatError(
      `reserved identifier ${RESERVED_ALIAS} is not allowed in view scripts`,
      id,
      m.line,
      m.column,
    );
  }

  // Extract the body via AST offsets (robust to esbuild's reflowing) and prepend
  // the prologue.
  const fn = ast.body.find(
    (n) => n.type === "FunctionDeclaration",
  ) as acorn.FunctionDeclaration;
  const body = fn.body;
  const bodyText = code.slice(body.start + 1, body.end - 1);
  const prologue = freeIdents.length
    ? `const {${freeIdents.join(",")}} = ${RESERVED_ALIAS};`
    : "";

  return `${JSON.stringify(id)}: function(node){"use strict";${prologue}${bodyText}}`;
}

export async function validateViewScript(
  id: string,
  script: string,
): Promise<string | null> {
  try {
    await compileView(id, script);
  } catch (err) {
    if (err instanceof ViewScriptError) return err.message;
    throw err;
  }
  return null;
}

export async function bundleViews(views: Views): Promise<string> {
  const entries: string[] = [];
  for (const [id, v] of Object.entries(views))
    entries.push(await compileView(id, v.script));

  let module = `import { viewGlobals as ${RESERVED_ALIAS} } from "./${APP_JS}";
export default {
${entries.join(",\n")}
};
`;

  if (process.env.NODE_ENV === "production") {
    const minified = await esbuild.transform(module, {
      loader: "js",
      format: "esm",
      minify: true,
    });
    module = minified.code;
  }

  return module;
}
