import test from "node:test";
import assert from "node:assert";
import {
  wrapElement,
  wrapEvent,
  wrapViewHandler,
  wrapViewMount,
  addManagedEventListener,
} from "../ui/view-membrane.ts";
import {
  ComputedSignal,
  runWithCleanupOwner,
  currentCleanupOwner,
} from "../ui/signals.ts";

// The membrane operates purely through property access on the raw element, so a
// minimal EventTarget-backed mock exercises the real proxy/cleanup logic
// without a browser DOM. Real EventTarget gives us working
// addEventListener/dispatchEvent/currentTarget; allowlisted props are plain own
// properties. The shape diverges from a real Element (readonly parentNode, no
// `value`, etc.), so it's its own interface and we cast to Element — via
// asEl/wrap — only at the membrane boundary, which is honest about it being a
// stand-in.
interface FakeElement {
  tagName: string;
  value: string;
  title: string;
  textContent: string;
  disabled: boolean;
  parentNode: FakeElement | null;
  // A property deliberately absent from every allowlist.
  ownerDocument: { secret: boolean };
  // A native-style method that depends on `this` identity, standing in for the
  // DOM methods (checkValidity, focus, ...) whose `this` brand-check rejects the
  // proxy — they must be bound to the raw element.
  checkValidity: () => boolean;
  addEventListener: EventTarget["addEventListener"];
  removeEventListener: EventTarget["removeEventListener"];
  dispatchEvent: EventTarget["dispatchEvent"];
}

function makeEl(): FakeElement {
  const el = new EventTarget() as unknown as FakeElement;
  el.tagName = "DIV";
  el.value = "";
  el.title = "";
  el.textContent = "";
  el.disabled = false;
  el.parentNode = null;
  el.ownerDocument = { secret: true };
  el.checkValidity = function (this: unknown): boolean {
    return this === el; // only true if bound to the raw element, not the proxy
  };
  return el;
}

const asEl = (el: FakeElement): Element => el as unknown as Element;
const wrap = (el: FakeElement): any => wrapElement(asEl(el));

// A standalone cleanup owner: cleanups anchored under it (via
// runWithCleanupOwner) run when it is disposed, standing in for the enclosing
// region computed a real view would supply.
const newOwner = (): ComputedSignal<unknown> =>
  new ComputedSignal<unknown>(() => null);

void test("wrapElement reads allowlisted props and blocks the rest", () => {
  const el = makeEl();
  el.value = "hello";
  const w = wrap(el);

  assert.strictEqual(w.value, "hello"); // RW prop readable
  assert.strictEqual(w.tagName, "DIV"); // RO prop readable
  assert.strictEqual(w.ownerDocument, undefined); // fails closed
  assert.strictEqual(w.innerHTML, undefined); // never allowlisted
});

void test("wrapElement: `in` matches the read allowlist (fails closed)", () => {
  const el = makeEl();
  const w = wrap(el);

  // Allowlisted names report present, blocked names report absent — consistent
  // with reads (no delegation to the raw target).
  assert.ok("value" in w); // RW prop
  assert.ok("tagName" in w); // RO prop
  assert.ok("addEventListener" in w); // method
  assert.ok("parentNode" in w); // navigator (present even when null)
  assert.strictEqual(w.parentNode, null);
  assert.ok(!("ownerDocument" in w)); // blocked, even though it exists on raw
  assert.ok(!("innerHTML" in w)); // never allowlisted
});

void test("wrapElement writes allowlisted props and ignores the rest", () => {
  const el = makeEl();
  const w = wrap(el);

  w.title = "set";
  assert.strictEqual(el.title, "set"); // RW write lands on raw

  // disabled is RW: view scripts can toggle it (e.g. a submit button).
  w.disabled = true;
  assert.strictEqual(el.disabled, true); // write lands on raw
  assert.strictEqual(w.disabled, true); // and reads back through the membrane

  // tagName is RO; the set trap returns false. In strict mode (esbuild output)
  // that surfaces as a TypeError; either way the raw value is untouched.
  assert.throws(() => {
    w.tagName = "SPAN";
  });
  assert.strictEqual(el.tagName, "DIV");
});

void test("wrapElement binds native methods to the raw element", () => {
  const el = makeEl();
  const w = wrap(el);

  // checkValidity is in METHODS, so the proxy returns it bound to the raw
  // element. It must work both called on the proxy and extracted as a bare fn
  // (the latter would throw "Illegal invocation" on a real DOM method if the
  // proxy were `this`, or if returned unbound).
  assert.strictEqual(w.checkValidity(), true);
  const fn = w.checkValidity;
  assert.strictEqual(fn(), true);
});

void test("wrapElement gives stable proxy identity per element", () => {
  const el = makeEl();
  assert.strictEqual(wrap(el), wrap(el));
});

void test("wrapElement wraps navigated-to nodes; listeners anchor to the owner", () => {
  const owner = newOwner();
  const parent = makeEl();
  const el = makeEl();
  el.parentNode = parent;

  const w = wrap(el);
  const wp = w.parentNode;
  assert.notStrictEqual(wp, parent); // wrapped, not raw
  assert.strictEqual(wp.tagName, "DIV"); // still a working membrane

  // A listener added to the navigated-to parent is anchored to the cleanup
  // owner in force when it was added, so it is torn down when the owner
  // disposes — cleanup follows navigation onto the computation axis.
  let fired = 0;
  runWithCleanupOwner(owner, () => wp.addEventListener("ping", () => fired++));
  parent.dispatchEvent(new Event("ping"));
  assert.strictEqual(fired, 1);

  owner[Symbol.dispose]();
  parent.dispatchEvent(new Event("ping"));
  assert.strictEqual(fired, 1); // not fired again — removed on owner disposal
});

void test("instrumented addEventListener auto-cleans on owner disposal", () => {
  const owner = newOwner();
  const el = makeEl();
  const w = wrap(el);

  let seenEvent: any = null;
  runWithCleanupOwner(owner, () =>
    w.addEventListener("click", (e: any) => (seenEvent = e)),
  );

  el.dispatchEvent(new Event("click"));
  assert.ok(seenEvent, "listener fired");
  assert.strictEqual(seenEvent.type, "click"); // receives a membraned event
  assert.strictEqual(seenEvent.target, w); // target membraned, stable identity

  seenEvent = null;
  owner[Symbol.dispose]();
  el.dispatchEvent(new Event("click"));
  assert.strictEqual(seenEvent, null); // removed on owner disposal
});

void test("instrumented removeEventListener detaches the wrapped listener", () => {
  const owner = newOwner();
  const el = makeEl();
  const w = wrap(el);

  let fired = 0;
  const fn = (): void => {
    fired++;
  };
  runWithCleanupOwner(owner, () => w.addEventListener("click", fn));
  el.dispatchEvent(new Event("click"));
  assert.strictEqual(fired, 1);

  runWithCleanupOwner(owner, () => w.removeEventListener("click", fn));
  el.dispatchEvent(new Event("click"));
  assert.strictEqual(fired, 1); // no longer firing
});

void test("addEventListener de-dupes a repeated (type, listener, capture)", () => {
  const owner = newOwner();
  const el = makeEl();
  const w = wrap(el);

  let fired = 0;
  const fn = (): void => {
    fired++;
  };
  // Native addEventListener treats the second registration of the same triple as
  // a no-op; the membrane must too, or the handler double-fires.
  runWithCleanupOwner(owner, () => {
    w.addEventListener("click", fn);
    w.addEventListener("click", fn);
  });
  el.dispatchEvent(new Event("click"));
  assert.strictEqual(fired, 1); // fired once, not twice

  // A single removeEventListener fully detaches it (no orphaned duplicate left).
  runWithCleanupOwner(owner, () => w.removeEventListener("click", fn));
  el.dispatchEvent(new Event("click"));
  assert.strictEqual(fired, 1);
});

void test("addEventListener keys by capture: differing capture are distinct", () => {
  const owner = newOwner();
  const el = makeEl();
  const w = wrap(el);

  let fired = 0;
  const fn = (): void => {
    fired++;
  };
  // (type, listener, capture=false) and (type, listener, capture=true) are two
  // distinct registrations under native semantics — both should attach and fire.
  runWithCleanupOwner(owner, () => {
    w.addEventListener("click", fn, { capture: false });
    w.addEventListener("click", fn, { capture: true });
  });
  el.dispatchEvent(new Event("click"));
  assert.strictEqual(fired, 2);
});

void test("addEventListener shares one wrapper across types, detaches per type", () => {
  const owner = newOwner();
  const el = makeEl();
  const w = wrap(el);

  let clicks = 0;
  let keys = 0;
  const fn = (e: any): void => {
    if (e.type === "click") clicks++;
    else keys++;
  };
  // One fn on two types reuses a single (owner, element, fn) wrapper, registered
  // under both types. Removing one type detaches only that registration (native
  // keys by type); the shared wrapper stays attached for the other.
  runWithCleanupOwner(owner, () => {
    w.addEventListener("click", fn);
    w.addEventListener("keydown", fn);
    w.removeEventListener("click", fn);
  });
  el.dispatchEvent(new Event("click"));
  el.dispatchEvent(new Event("keydown"));
  assert.strictEqual(clicks, 0); // detached
  assert.strictEqual(keys, 1); // still attached — not orphaned by the removal
});

void test("re-add after removeEventListener re-attaches the listener", () => {
  const owner = newOwner();
  const el = makeEl();
  const w = wrap(el);

  let fired = 0;
  const fn = (): void => {
    fired++;
  };
  runWithCleanupOwner(owner, () => {
    w.addEventListener("click", fn);
    w.removeEventListener("click", fn);
  });
  el.dispatchEvent(new Event("click"));
  assert.strictEqual(fired, 0); // detached

  // The wrapper survives the remove; re-adding reuses it and native re-attaches.
  runWithCleanupOwner(owner, () => w.addEventListener("click", fn));
  el.dispatchEvent(new Event("click"));
  assert.strictEqual(fired, 1);
});

void test("removeEventListener under a different owner is a safe no-op", () => {
  const ownerA = newOwner();
  const ownerB = newOwner();
  const el = makeEl();
  const w = wrap(el);

  let fired = 0;
  const fn = (): void => {
    fired++;
  };
  runWithCleanupOwner(ownerA, () => w.addEventListener("click", fn));

  // Off-idiom: a callback added under one owner, removed under another. remove is
  // owner-scoped, so B's lookup misses and does nothing — the listener stays
  // attached and tears down only when its real owner (A) disposes. (Across
  // components, pass a signal rather than sharing a callback.)
  runWithCleanupOwner(ownerB, () => w.removeEventListener("click", fn));
  el.dispatchEvent(new Event("click"));
  assert.strictEqual(fired, 1); // not detached by the cross-owner remove

  ownerA[Symbol.dispose]();
  el.dispatchEvent(new Event("click"));
  assert.strictEqual(fired, 1); // torn down with its real owner — never leaked
});

void test("addEventListener supports the object listener form ({handleEvent})", () => {
  const owner = newOwner();
  const el = makeEl();
  const w = wrap(el);

  let seen: any = null;
  // Native accepts an object with handleEvent; the membrane must too, and still
  // deliver a membraned event and detach via removeEventListener.
  const handler = {
    handleEvent(e: any): void {
      seen = e;
    },
  };
  runWithCleanupOwner(owner, () => w.addEventListener("click", handler));
  el.dispatchEvent(new Event("click"));
  assert.ok(seen, "object listener fired");
  assert.strictEqual(seen.type, "click");
  assert.strictEqual(seen.target, w); // membraned event

  seen = null;
  runWithCleanupOwner(owner, () => w.removeEventListener("click", handler));
  el.dispatchEvent(new Event("click"));
  assert.strictEqual(seen, null); // detached
});

void test("addEventListener with a null listener is a no-op", () => {
  const el = makeEl();
  const w = wrap(el);
  // Native ignores a null listener; the membrane must not throw.
  assert.doesNotThrow(() => w.addEventListener("click", null));
  assert.doesNotThrow(() => w.removeEventListener("click", null));
});

void test("add/removeEventListener under a null/disposed owner throw", () => {
  // A null/disposed owner is unreachable from sanctioned view code (async/await
  // is bundler-rejected, so view code never resumes in an owner-less microtask),
  // so reaching add/remove without a live owner is a structural bug — assert.
  const el = makeEl();
  const w = wrap(el);

  // Disposed owner.
  const disposed = newOwner();
  disposed[Symbol.dispose]();
  assert.throws(
    () =>
      runWithCleanupOwner(disposed, () =>
        w.addEventListener("click", () => {}),
      ),
    /no live cleanup owner/,
  );
  assert.throws(
    () =>
      runWithCleanupOwner(disposed, () =>
        w.removeEventListener("click", () => {}),
      ),
    /no live cleanup owner/,
  );

  // No owner in force at all.
  assert.throws(
    () => w.addEventListener("click", () => {}),
    /no live cleanup owner/,
  );
  assert.throws(
    () => w.removeEventListener("click", () => {}),
    /no live cleanup owner/,
  );
});

void test("addManagedEventListener re-establishes the owner and membranes the event", () => {
  // Exercises the generic EventTarget path that window listeners (view-globals)
  // route through: the handler must run under the owner live at add time, receive
  // a membraned event, and auto-remove on owner disposal. makeEl() is a real
  // EventTarget, standing in for window here.
  const owner = newOwner();
  const target = makeEl();

  let ownerDuringDispatch: unknown = "unset";
  let seen: any = null;
  const fn = (e: any): void => {
    ownerDuringDispatch = currentCleanupOwner();
    seen = e;
  };
  runWithCleanupOwner(owner, () =>
    addManagedEventListener(asEl(target), "ping", fn),
  );

  target.dispatchEvent(new Event("ping"));
  assert.strictEqual(ownerDuringDispatch, owner); // owner re-established
  assert.strictEqual(seen.type, "ping"); // membraned event delivered
  assert.strictEqual(seen.view, undefined); // raw-event/window escape blocked

  ownerDuringDispatch = "unset";
  owner[Symbol.dispose]();
  target.dispatchEvent(new Event("ping"));
  assert.strictEqual(ownerDuringDispatch, "unset"); // detached on owner disposal
});

void test("wrapEvent exposes a curated, fail-closed surface", () => {
  const el = makeEl();
  const raw = new Event("keydown");
  (raw as any).key = "Enter";
  let prevented = false;
  raw.preventDefault = (): void => {
    prevented = true;
  };

  const w = wrapEvent(raw, asEl(el)) as any;
  assert.strictEqual(w.type, "keydown"); // allowlisted prop
  assert.strictEqual(w.key, "Enter"); // allowlisted prop
  assert.strictEqual(w.view, undefined); // window escape — blocked
  assert.strictEqual(w.composedPath, undefined); // blocked
  assert.strictEqual(w.currentTarget, wrap(el)); // membraned

  w.preventDefault();
  assert.strictEqual(prevented, true); // method bound to raw

  // `in` mirrors the allowlist, consistent with the fail-closed reads above.
  assert.ok("type" in w); // allowlisted prop
  assert.ok("preventDefault" in w); // allowlisted method
  assert.ok("target" in w); // membraned navigator
  assert.ok(!("view" in w)); // blocked window escape
  assert.ok(!("composedPath" in w)); // blocked
});

void test("wrapViewHandler delivers a membraned event to the handler", () => {
  const el = makeEl();
  const owner = newOwner();

  let seen: any = null;
  // The wrapper captures the owner at build time, so build it under one (as
  // renderView does).
  const handler = runWithCleanupOwner(owner, () =>
    wrapViewHandler((e) => (seen = e)),
  );
  el.addEventListener("click", handler);
  el.dispatchEvent(new Event("click"));

  assert.ok(seen);
  assert.strictEqual(seen.type, "click");
  assert.strictEqual(seen.currentTarget, wrap(el)); // membraned
  assert.strictEqual(seen.target.ownerDocument, undefined); // membrane intact
});

void test("wrapViewMount delivers a membraned element and passes through return", () => {
  const el = makeEl();
  el.value = "v";
  const owner = newOwner();

  let seen: any = null;
  const cleanup = (): void => {};
  const mount = runWithCleanupOwner(owner, () =>
    wrapViewMount((wel) => {
      seen = wel;
      return cleanup;
    }),
  );
  const mounted = mount(asEl(el));

  assert.strictEqual(seen, wrap(el)); // membraned element
  assert.strictEqual(seen.value, "v");
  assert.strictEqual(seen.ownerDocument, undefined);
  assert.strictEqual(mounted, cleanup); // return value preserved for dom.ts
});

void test("wrapViewHandler / wrapViewMount throw when built without an owner", () => {
  // A null owner at build time is a structural invariant violation (the view
  // tree is built outside a region computed), so the wrappers assert rather
  // than run the callback unanchored.
  assert.throws(() => wrapViewHandler(() => {}), /no cleanup owner/);
  assert.throws(() => wrapViewMount(() => {}), /no cleanup owner/);
});
