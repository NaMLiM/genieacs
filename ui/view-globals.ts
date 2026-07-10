import {
  Signal,
  setTimeout as wrappedSetTimeout,
  setInterval as wrappedSetInterval,
} from "./signals.ts";
import {
  addManagedEventListener,
  removeManagedEventListener,
} from "./view-membrane.ts";
import { ViewNode } from "./views.ts";
import { SkewedDate } from "./skewed-date.ts";

// The view JSX factory.
function h(
  name: string,
  attributes: Record<string, any> | null,
  ...children: any[]
): ViewNode {
  return new ViewNode(name, attributes, children.flat());
}

// Exposes only the safe members of window; everything else resolves to undefined.
// addEventListener/removeEventListener point at the same scoped wrappers as the
// bare globals below, so window.addEventListener(...) and addEventListener(...)
// behave identically (as they do on a real window).
const windowFacade = Object.freeze({
  prompt: window.prompt.bind(window),
  confirm: window.confirm.bind(window),
  addEventListener,
  removeEventListener,
});

// A bare addEventListener(...) in a view script means window.addEventListener.
// Routed through the membrane like element listeners (see view-membrane.ts):
// owner-scoped against `window`, wrapped to anchor what the handler spawns, and
// auto-removed on owner recompute/disposal. There is no unscoped fallback — a
// null/disposed owner is a structural bug (addManagedEventListener throws), since
// an un-anchored window listener would leak permanently.
function addEventListener(
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): void {
  addManagedEventListener(window, type, listener, options);
}

function removeEventListener(
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | EventListenerOptions,
): void {
  removeManagedEventListener(window, type, listener, options);
}

// The frozen allowlist each view body destructures its free identifiers from; a
// bare reference to any name not listed here fails closed to undefined.
//
// This is a guardrail, not a security sandbox: it keeps view authors from
// accidentally reaching for host globals (document, fetch, …), but it cannot
// contain hostile code — e.g. Object.constructor.constructor still yields
// Function, and from there the real global scope. Views are trusted,
// admin-authored config; do not rely on this allowlist as an isolation boundary.
export const viewGlobals = Object.freeze({
  h,
  Signal,

  // wrapped timers auto-clear on owner disposal/recompute; clear* pair with them
  setTimeout: wrappedSetTimeout,
  setInterval: wrappedSetInterval,
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),

  // value globals
  Math,
  Object,
  String,
  Boolean,
  Number,
  Array,
  Map,
  Set,
  RegExp,
  Error,
  JSON,
  URL,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  decodeURIComponent,
  encodeURIComponent,
  Date: SkewedDate, // server-skew-adjusted clock

  // host bridges
  prompt: window.prompt.bind(window),
  confirm: window.confirm.bind(window),
  window: windowFacade,

  // scoped global event listeners, auto-cleaned on view teardown
  addEventListener,
  removeEventListener,
});
