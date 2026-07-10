import {
  currentCleanupOwner,
  runWithCleanupOwner,
  registerCleanup,
  type ComputedSignal,
} from "./signals.ts";

// The membrane wraps the element/event surface a view script can touch: every
// listener it adds is auto-tracked and torn down on view teardown/rebuild, and
// the cleanup scope propagates through DOM navigation. Anything not allowlisted
// resolves to undefined (fails closed) rather than leaking a raw element/event.
//
// Cleanup rides one axis — the computation. Every resource a script creates (a
// listener, timer, or signal) anchors to the cleanup owner in force when it is
// created and is torn down when that computed recomputes or is disposed. The
// owner is the enclosing region computed, captured at build/add time and
// re-established around the later dispatch. A view-script element is disposed
// exactly when its region computed recomputes, so this tracks the element's DOM
// lifetime without the membrane tracking element lifetimes itself.

// Readable + writable leaf props: primitive/string IDL values with no leak or
// injection surface, so view scripts may read and set them (e.g. toggle
// `disabled`, drive a `<select>` via `selectedIndex`).
const RW_PROPS = new Set([
  "textContent",
  "innerText",
  "value",
  "checked",
  "title",
  "className",
  "id",
  "hidden",
  "scrollTop",
  "scrollLeft",
  "disabled",
  "selectedIndex",
  "name",
  "type",
]);

// Read-only leaf props (layout metrics and intrinsic node identity).
const RO_PROPS = new Set([
  "tagName",
  "nodeName",
  "nodeType",
  "clientWidth",
  "clientHeight",
  "offsetWidth",
  "offsetHeight",
  "scrollWidth",
  "scrollHeight",
  "validity",
  "files", // FileList of File (strings/blobs only, no element reference)
]);

// Safe methods (bound to the raw element)
const METHODS = new Set([
  "focus",
  "blur",
  "click",
  "select",
  "scrollIntoView",
  "getBoundingClientRect",
  "getAttribute",
  "setAttribute", // guarded (below): on* attribute names are rejected
  "removeAttribute",
  "hasAttribute",
  "matches",
  "checkValidity", // native method: must be bound to the raw element, not
  // returned as a bare function (its `this` brand-check rejects the proxy)
  "addEventListener", // instrumented (below)
  "removeEventListener", // instrumented (below)
]);

// Sub-objects we hand through raw (curated, leak-free)
//   classList  -> raw (DOMTokenList; cannot reach an element)
//   style      -> raw (CSSStyleDeclaration; cannot reach an element)
//   dataset    -> raw (DOMStringMap; strings only)
const PASSTHROUGH_OBJECTS = new Set(["classList", "style", "dataset"]);

// Node-returning navigators: return a WRAPPED node carrying the membrane.
const NODE_PROPS = new Set([
  "parentNode",
  "parentElement",
  "firstElementChild",
  "lastElementChild",
  "nextElementSibling",
  "previousElementSibling",
]);
const NODE_METHODS = new Set(["closest", "querySelector"]);
const NODELIST_METHODS = new Set(["querySelectorAll"]); // -> array of wrapped

// Deliberately NOT listed (=> undefined): ownerDocument, getRootNode,
// offsetParent, defaultView, innerHTML/outerHTML (string injection),
// insertAdjacentHTML, append/before/after (can insert foreign nodes), etc.

// Registry of the wrappers we attached, so removeEventListener can find and
// detach the exact wrapper we registered. Targets are EventTargets: a wrapped
// element or `window` (via view-globals).
//
// Rooted on the cleanup OWNER, not a global target index. Each (owner, target,
// fn) gets exactly ONE wrapper, reused across that fn's (type, capture)
// registrations: handing native the same wrapper identity lets it de-dupe a
// repeat so the handler fires once (a fresh wrapper would double-fire). The
// wrapper closes over the owner to re-establish that cleanup scope around
// dispatch, so it can't be shared across owners — hence add/remove are
// owner-SCOPED, looking the wrapper up in the current owner's map. Within one
// owner this is exactly native (idempotent add, one remove kills it).
type ListenerMap = Map<EventListenerOrEventListenerObject, EventListener>;
const ownerListeners = new WeakMap<
  ComputedSignal<unknown>,
  WeakMap<EventTarget, ListenerMap>
>();

// The per-target listener map for an owner, created on demand.
function listenerMapFor(
  owner: ComputedSignal<unknown>,
  target: EventTarget,
): ListenerMap {
  let byTarget = ownerListeners.get(owner);
  if (!byTarget) {
    byTarget = new WeakMap();
    ownerListeners.set(owner, byTarget);
  }
  let perTarget = byTarget.get(target);
  if (!perTarget) {
    perTarget = new Map();
    byTarget.set(target, perTarget);
  }
  return perTarget;
}

// Owner-scoped, membraned addEventListener for any EventTarget — a wrapped
// element (via the proxy below) or `window` (via view-globals). Used directly for
// window; the element proxy routes through instrumentedAdd.
export function addManagedEventListener(
  target: EventTarget,
  type: string,
  listener: EventListenerOrEventListenerObject | null,
  opts?: boolean | AddEventListenerOptions,
): void {
  if (!listener) return; // native treats a null listener as a no-op

  // Resolve the cleanup owner at add time: the computing signal, or the ambient
  // owner re-established for this dispatch. View scripts always run synchronously
  // under a live owner (async/await is bundler-rejected), so a missing owner is a
  // structural bug — assert rather than attach an un-anchored listener (a window
  // listener would then leak permanently).
  const owner = currentCleanupOwner();
  if (owner === null || owner._disposed)
    throw new Error(
      "addManagedEventListener: no live cleanup owner (view code must run " +
        "synchronously under its region computed)",
    );

  const perTarget = listenerMapFor(owner, target);
  // One wrapper per (owner, target, fn), reused across this fn's (type, capture)
  // registrations so native de-dupes a repeat (fires once).
  let wrapped = perTarget.get(listener);
  if (!wrapped) {
    wrapped = (ev) => {
      // Re-establish the owner around dispatch so resources the handler spawns
      // (timers, nested listeners/signals) anchor to it and tear down with it.
      runWithCleanupOwner(owner, () => {
        const e = wrapEvent(ev, ev.currentTarget as EventTarget) as Event;
        // Function and object ({handleEvent}) listener forms, as native allows.
        if (typeof listener === "function") listener(e);
        else listener.handleEvent(e);
      });
    };
    perTarget.set(listener, wrapped);
  }
  target.addEventListener(type, wrapped, opts);

  // Anchor removal to the owner: torn down when it recomputes or disposes. Each
  // (type, opts) gets its own cleanup since the shared wrapper may be attached
  // for several types. Prune the slot here (every type's cleanup runs at
  // teardown) but never on an explicit remove, so a later re-add reuses it.
  registerCleanup(() => {
    target.removeEventListener(type, wrapped, opts);
    if (perTarget.get(listener) === wrapped) perTarget.delete(listener);
  });
}

// Owner-scoped removeEventListener counterpart (see addManagedEventListener).
export function removeManagedEventListener(
  target: EventTarget,
  type: string,
  listener: EventListenerOrEventListenerObject | null,
  opts?: boolean | EventListenerOptions,
): void {
  if (!listener) return; // native treats a null listener as a no-op

  // Owner-scoped: look up the wrapper in the current owner's map and detach only
  // this `type` (native keys by type; the shared wrapper's other types stay
  // attached). Don't prune — a later re-add reuses it, and the owner's cleanup
  // still detaches it at teardown. A listener added under a different live owner
  // won't be found (it tears down with its own owner): keep callbacks within one
  // component, pass signals across boundaries. A missing owner is a structural
  // bug — assert, as addManagedEventListener does.
  const owner = currentCleanupOwner();
  if (owner === null || owner._disposed)
    throw new Error(
      "removeManagedEventListener: no live cleanup owner (view code must run " +
        "synchronously under its region computed)",
    );
  const wrapped = ownerListeners.get(owner)?.get(target)?.get(listener);
  if (wrapped) target.removeEventListener(type, wrapped, opts);
}

function instrumentedAdd(raw: EventTarget) {
  return (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    opts?: boolean | AddEventListenerOptions,
  ): void => addManagedEventListener(raw, type, listener, opts);
}

function instrumentedRemove(raw: EventTarget) {
  return (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    opts?: boolean | EventListenerOptions,
  ): void => removeManagedEventListener(raw, type, listener, opts);
}

// Cache of wrapper proxies keyed by raw target for stable identity (so
// e.target === e.currentTarget for the same element). The proxy holds no
// per-dispatch state — cleanup resolves its owner at add time — so one proxy per
// target suffices. Keyed by EventTarget, not Element: a window target is wrapped
// fail-closed like any non-allowlisted surface.
const cache = new WeakMap<EventTarget, object>();

export function wrapElement(raw: EventTarget): object {
  const hit = cache.get(raw);
  if (hit) return hit;

  const proxy = new Proxy(raw, {
    get(target, prop) {
      if (prop === "addEventListener") return instrumentedAdd(raw);
      if (prop === "removeEventListener") return instrumentedRemove(raw);
      if (prop === "setAttribute")
        return (name: string, value: string): void => {
          // Block inline on* handler injection (setAttribute("onclick", …)): the
          // browser would run it in global scope, escaping the membrane. No-op.
          if (/^on/i.test(name)) return;
          (raw as Element).setAttribute(name, value);
        };
      if (NODE_PROPS.has(prop as string)) {
        const n = (target as any)[prop];
        return n ? wrapElement(n) : n;
      }
      if (NODE_METHODS.has(prop as string))
        return (sel: string) => {
          const n = (target as any)[prop](sel);
          return n ? wrapElement(n) : n;
        };
      if (NODELIST_METHODS.has(prop as string))
        return (sel: string) =>
          Array.from((target as any)[prop](sel), (n) =>
            wrapElement(n as Element),
          );
      if (METHODS.has(prop as string))
        return (target as any)[prop].bind(target);
      if (PASSTHROUGH_OBJECTS.has(prop as string)) return (target as any)[prop];
      if (RW_PROPS.has(prop as string) || RO_PROPS.has(prop as string))
        return (target as any)[prop];
      return undefined; // fail closed
    },
    set(target, prop, value) {
      if (RW_PROPS.has(prop as string)) {
        (target as any)[prop] = value;
        return true;
      }
      return false; // silently ignored / throws in strict mode
    },
    has(_target, prop) {
      // Mirror the get allowlist so `in` matches reads (a blocked prop reads
      // undefined AND reports absent). The special-cased names are all in
      // METHODS; symbols miss the string Sets and fail closed.
      const p = prop as string;
      return (
        RW_PROPS.has(p) ||
        RO_PROPS.has(p) ||
        METHODS.has(p) ||
        PASSTHROUGH_OBJECTS.has(p) ||
        NODE_PROPS.has(p) ||
        NODE_METHODS.has(p) ||
        NODELIST_METHODS.has(p)
      );
    },
  });

  cache.set(raw, proxy);
  return proxy;
}

const EVENT_PROPS = new Set([
  "type",
  "data", // InputEvent: inserted text (string)
  "inputType", // InputEvent: kind of edit (string)
  "key",
  "code",
  "keyCode",
  "which",
  "button",
  "buttons",
  "detail",
  "deltaX",
  "deltaY",
  "deltaZ",
  "deltaMode",
  "clientX",
  "clientY",
  "pageX",
  "pageY",
  "offsetX",
  "offsetY",
  "screenX",
  "screenY",
  "movementX",
  "movementY",
  "altKey",
  "ctrlKey",
  "shiftKey",
  "metaKey",
  "isTrusted",
  "timeStamp",
  "defaultPrevented",
  "bubbles",
  "cancelable",
]);
const EVENT_METHODS = new Set([
  "preventDefault",
  "stopPropagation",
  "stopImmediatePropagation",
  "getModifierState",
]);
// Omitted (=> undefined): view (window), composedPath, relatedTarget,
// srcElement, path, submitter, etc. Also omitted because they carry a raw
// element back out of the membrane: touches/targetTouches/changedTouches
// (Touch.target), clipboardData/dataTransfer — add explicit wrapping if needed.

export function wrapEvent(rawEvent: Event, currentTarget: EventTarget): object {
  return new Proxy(rawEvent, {
    get(t, prop) {
      if (prop === "target") return t.target ? wrapElement(t.target) : t.target;
      if (prop === "currentTarget") return wrapElement(currentTarget);
      if (EVENT_METHODS.has(prop as string)) return (t as any)[prop].bind(t);
      if (EVENT_PROPS.has(prop as string)) return (t as any)[prop];
      return undefined; // fail closed
    },
    has(_t, prop) {
      // Mirror the get allowlist so `in` matches reads (see wrapElement's has).
      const p = prop as string;
      return (
        p === "target" ||
        p === "currentTarget" ||
        EVENT_METHODS.has(p) ||
        EVENT_PROPS.has(p)
      );
    },
  });
}

// Adapter installed by views.ts:toChild for a view's on* attribute. The owner is
// captured at build time (where `computing` is the region computed) and
// re-established around the later dispatch so addEventListener/timers in the
// handler anchor correctly; the handler receives a membraned event.
//
// A handler runs under the owner of the element it is bound to, so a callback
// passed across component boundaries runs under the CHILD's owner. To talk across
// components, pass a state signal rather than a callback.
export function wrapViewHandler(fn: (e: any) => void): EventListener {
  // Captured inside renderView's runWithCleanupOwner block, so always live here.
  // A null owner means the view tree is built outside a region computed — a
  // structural bug — so assert rather than run the handler unanchored.
  const owner = currentCleanupOwner();
  if (owner === null)
    throw new Error(
      "wrapViewHandler: no cleanup owner (view built outside a region computed)",
    );
  return (rawEvent) => {
    const el = rawEvent.currentTarget as Element; // the bound element
    runWithCleanupOwner(owner, () => fn(wrapEvent(rawEvent, el)));
  };
}

// Adapter installed by views.ts:toChild for a view's onMount attribute. Like
// wrapViewHandler, the owner is captured at build time and re-established around
// the callback (onMount fires as a microtask). The callback receives a membraned
// element; its return value passes through so dom.ts still defers a returned
// cleanup (redundant now, kept for compatibility).
export function wrapViewMount(
  fn: (el: any) => unknown,
): (el: Element) => unknown {
  // See wrapViewHandler: owner captured at build time, always live; a null owner
  // is a structural invariant violation, so assert.
  const owner = currentCleanupOwner();
  if (owner === null)
    throw new Error(
      "wrapViewMount: no cleanup owner (view built outside a region computed)",
    );
  return (rawEl) => runWithCleanupOwner(owner, () => fn(wrapElement(rawEl)));
}
