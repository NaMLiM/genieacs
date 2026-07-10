// Reactive signals system based on the TC39 Signals proposal.
// https://github.com/tc39/proposal-signals

export const enum ComputedState {
  Clean,
  Computing,
  Checking,
  Dirty,
}

// Creates a Proxy that hides underscore-prefixed properties
function createSafeProxy<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === "string" && prop.startsWith("_")) {
        return undefined;
      }
      const value = Reflect.get(obj, prop, obj);
      if (typeof value === "function") {
        return value.bind(obj);
      }
      return value;
    },
    set(obj, prop, value) {
      if (typeof prop === "string" && prop.startsWith("_")) {
        return false;
      }
      return Reflect.set(obj, prop, value, obj);
    },
    ownKeys(obj) {
      return Reflect.ownKeys(obj).filter(
        (key) => typeof key !== "string" || !key.startsWith("_"),
      );
    },
    getOwnPropertyDescriptor(obj, prop) {
      if (typeof prop === "string" && prop.startsWith("_")) {
        return undefined;
      }
      return Reflect.getOwnPropertyDescriptor(obj, prop);
    },
  });
}

// Optional change gate for StateSignal/ComputedSignal, the TC39 Signals
// `equals` hook. When it reports the next value equal to the previous one,
// the signal keeps the previous reference and does not notify dependents.
export interface SignalOptions<T> {
  equals?: (prev: T, next: T) => boolean;
}

// Tracks the currently computing signal for automatic dependency registration
let computing: ComputedSignal<unknown> | null = null;

// The ambient cleanup owner used when `computing` is null. Re-established by
// runWithCleanupOwner across timer callbacks and view event-handler/onMount
// dispatch, so resources a view script creates outside a live computation still
// anchor to the owning computed. DISTINCT from `computing`: it governs cleanup
// ownership only, never dependency tracking — a signal read inside such a
// callback must NOT make the owner depend on it.
let cleanupOwner: ComputedSignal<unknown> | null = null;

// The computed that should own cleanups registered right now: the computing
// signal if a computation is in force, else the ambient cleanup owner.
export function currentCleanupOwner(): ComputedSignal<unknown> | null {
  return computing ?? cleanupOwner;
}

// Re-establish `signal` as the ambient cleanup owner for `fn`, WITHOUT making it
// the computing signal — cleanups registered inside `fn` anchor to `signal`, but
// signal reads do not register dependencies on it. Carries a view's cleanup
// scope across boundaries where `computing` has unwound (timer callbacks, event
// handlers, onMount).
export function runWithCleanupOwner<T>(
  signal: ComputedSignal<unknown>,
  fn: () => T,
): T {
  const prev = cleanupOwner;
  cleanupOwner = signal;
  try {
    return fn();
  } finally {
    cleanupOwner = prev;
  }
}

// Run callback outside reactive tracking scope. Child computeds won't register
// as dependencies of the currently-evaluating parent. Equivalent to TC39 Signal.subtle.untrack().
export function untracked<T>(fn: () => T): T {
  const prev = computing;
  computing = null;
  try {
    return fn();
  } finally {
    computing = prev;
  }
}

export function registerDependency(source: SignalBase<unknown>): void {
  if (computing !== null) {
    source._sinks.add(computing._selfRef);
    computing._sources.add(source);
  }
}

// Defer a teardown onto the current cleanup owner. Returns true if there was a
// live owner to anchor to; false means the cleanup was dropped (no owner, or the
// owner is already disposed), letting callers mirror the timer wrappers'
// unscoped fallback.
export function registerCleanup(cleanup: () => void): boolean {
  const owner = currentCleanupOwner();
  if (owner !== null && !owner._disposed) {
    owner._cleanups.add(cleanup);
    return true;
  }
  return false;
}

const NEVER_ABORTED = AbortSignal.any([]);

// Returns the AbortSignal of the current cleanup owner — the enclosing
// ComputedSignal, or the ambient owner re-established across an async/dispatch
// boundary (so a fetch started from a timer callback still aborts on the owning
// computed's recompute/disposal). With no owner in force, returns a signal that
// never aborts.
export function abortSignal(): AbortSignal {
  const owner = currentCleanupOwner();
  if (owner === null) return NEVER_ABORTED;
  return owner.abortSignal;
}

function runCleanups(signal: ComputedSignal<unknown>): void {
  if (signal._abortController) {
    signal._abortController.abort();
    signal._abortController = null;
  }
  for (const cleanup of signal._cleanups) {
    cleanup();
  }
  signal._cleanups.clear();
}

// Type for sinks: can be ComputedSignal or Watcher.
type Sink = ComputedSignal<unknown> | Watcher;

function markSinksChecking(sinks: Set<WeakRef<Sink>>): void {
  // Iterate over a snapshot to avoid issues with set modification during iteration
  // (computed signals remove/re-add themselves during recomputation)
  const snapshot = [...sinks];
  for (const weakRef of snapshot) {
    const sink = weakRef.deref();
    if (sink === undefined) {
      sinks.delete(weakRef);
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    if (sink instanceof Watcher) {
      sink._notify();
      continue;
    }

    // Only promote Clean to Checking (Dirty/Checking stay as-is)
    if (sink._state === ComputedState.Clean) {
      sink._state = ComputedState.Checking;
      markSinksChecking(sink._sinks);
    }
  }
}

export function markSinksDirty(sinks: Set<WeakRef<Sink>>): void {
  // Iterate over a snapshot to avoid issues with set modification during iteration
  // (computed signals remove/re-add themselves during recomputation)
  const snapshot = [...sinks];
  for (const weakRef of snapshot) {
    const sink = weakRef.deref();
    if (sink === undefined) {
      sinks.delete(weakRef);
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    if (sink instanceof Watcher) {
      sink._notify();
      continue;
    }

    // Promote Clean or Checking to Dirty
    if (
      sink._state === ComputedState.Clean ||
      sink._state === ComputedState.Checking
    ) {
      runCleanups(sink);
      sink._state = ComputedState.Dirty;
      markSinksChecking(sink._sinks); // Indirect dependents become Checking
    }
  }
}

export abstract class SignalBase<T = unknown> implements Disposable {
  declare _sinks: Set<WeakRef<Sink>>;
  _disposed: boolean = false;

  abstract get(): T;
  abstract [Symbol.dispose](): void;
}

export class ConstSignal<T> extends SignalBase<T> {
  private _value: T;

  constructor(value: T) {
    super();
    this._value = value;

    // Self-dispose when created under a cleanup owner (a live computation, or
    // the ambient owner across an async/dispatch boundary).
    if (currentCleanupOwner() !== null) {
      registerCleanup(() => this[Symbol.dispose]());
    }
  }

  get(): T {
    if (this._disposed) throw new Error("Cannot read disposed signal");
    return this._value;
  }

  [Symbol.dispose](): void {
    if (this._disposed) return;
    this._disposed = true;
    this._value = undefined as T;
  }
}

export class StateSignal<T> extends SignalBase<T> {
  private _value: T;
  private _equals: (prev: T, next: T) => boolean;

  constructor(initialValue: T, options?: SignalOptions<T>) {
    super();
    this._sinks = new Set();
    this._value = initialValue;
    this._equals = options?.equals ?? Object.is;

    // Self-dispose when created under a cleanup owner (a live computation, or
    // the ambient owner across an async/dispatch boundary).
    if (currentCleanupOwner() !== null) {
      registerCleanup(() => this[Symbol.dispose]());
    }
  }

  get(): T {
    if (this._disposed) throw new Error("Cannot read disposed signal");
    registerDependency(this);
    return this._value;
  }

  set(newValue: T): void {
    if (this._disposed) throw new Error("Cannot write to disposed signal");
    if (this._equals(this._value, newValue)) return;
    this._value = newValue;
    markSinksDirty(this._sinks);
  }

  // Atomic read-modify-write with an untracked read (direct field access)
  update(fn: (prev: T) => T): void {
    if (this._disposed) throw new Error("Cannot write to disposed signal");
    this.set(fn(this._value));
  }

  [Symbol.dispose](): void {
    if (this._disposed) return;
    this._disposed = true;
    this._value = undefined as T;
    this._sinks.clear();
  }
}

export class ComputedSignal<T> extends SignalBase<T> {
  private _callback: () => T;
  private _value: T | undefined;
  private _error: unknown;
  private _hasError: boolean = false;
  private _hasValue: boolean = false;
  private _equals: ((prev: T, next: T) => boolean) | null;

  _state: ComputedState = ComputedState.Dirty;
  _sources: Set<SignalBase<unknown>> = new Set();
  _cleanups: Set<() => void> = new Set();
  _abortController: AbortController | null = null;

  // Single WeakRef reused when registering with sources for memory efficiency
  readonly _selfRef: WeakRef<ComputedSignal<unknown>>;

  constructor(callback: () => T, options?: SignalOptions<T>) {
    super();
    this._sinks = new Set();
    this._callback = callback;
    this._equals = options?.equals ?? null;
    this._selfRef = new WeakRef(this as ComputedSignal<unknown>);

    // Self-dispose when created under a cleanup owner (a live computation, or
    // the ambient owner across an async/dispatch boundary).
    if (currentCleanupOwner() !== null) {
      registerCleanup(() => this[Symbol.dispose]());
    }
  }

  get abortSignal(): AbortSignal {
    if (!this._abortController) this._abortController = new AbortController();
    return this._abortController.signal;
  }

  get(): T {
    if (this._disposed) throw new Error("Cannot read disposed signal");
    registerDependency(this);

    if (this._state === ComputedState.Computing) {
      throw new Error("Circular dependency detected");
    }

    if (!this._isValid()) return this._recompute();

    if (this._hasError) throw this._error;
    return this._value as T;
  }

  _isValid(): boolean {
    if (this._state === ComputedState.Clean) return true;
    if (this._state !== ComputedState.Checking) return false;
    // Checking: verify if sources have changed
    for (const source of this._sources) {
      if (source instanceof ComputedSignal) {
        source.get(); // Triggers recomputation if source is Dirty/Checking
        // If source's value changed, it would have marked us Dirty
        if ((this._state as ComputedState) === ComputedState.Dirty)
          return false;
      }
    }
    // All sources unchanged, we're clean
    this._state = ComputedState.Clean;
    return true;
  }

  private _recompute(): T {
    // Clear old dependencies
    for (const source of this._sources) {
      source._sinks.delete(this._selfRef);
    }
    this._sources.clear();

    const prevComputing = computing;
    computing = this as ComputedSignal<unknown>;
    this._state = ComputedState.Computing;

    try {
      const oldValue = this._value;
      const hadError = this._hasError;
      const hadValue = this._hasValue;
      this._value = this._callback();
      this._hasError = false;
      this._hasValue = true;
      this._state = ComputedState.Clean;
      if (
        !hadError &&
        hadValue &&
        this._equals &&
        this._equals(oldValue as T, this._value)
      ) {
        // The comparator deems the recomputed value unchanged: keep the
        // prior reference and stay silent so dependents see stable identity.
        this._value = oldValue as T;
      } else if (hadError || !Object.is(oldValue, this._value)) {
        // Value changed, mark sinks dirty (for Checking optimization)
        markSinksDirty(this._sinks);
      }
      return this._value;
    } catch (e) {
      const oldError = this._error;
      const hadError = this._hasError;
      this._error = e;
      this._hasError = true;
      this._state = ComputedState.Clean;
      // If error changed, mark sinks dirty
      if (!hadError || !Object.is(oldError, e)) {
        markSinksDirty(this._sinks);
      }
      throw e;
    } finally {
      computing = prevComputing;
    }
  }

  [Symbol.dispose](): void {
    if (this._disposed) return;
    this._disposed = true;

    // Run all registered cleanups (clears timeouts/intervals and disposes
    // nested signals)
    runCleanups(this as ComputedSignal<unknown>);

    // Detach from sources
    for (const source of this._sources) {
      source._sinks?.delete(this._selfRef);
    }
    this._sources.clear();

    // Clear sinks
    this._sinks.clear();

    // Release references for GC
    this._value = undefined;
    this._hasValue = false;
    this._error = undefined;
  }
}

// Observes signal changes from outside the reactive graph.
// Based on the TC39 Signals proposal's Signal.subtle.Watcher.
// The notify callback fires synchronously and should be lightweight
// (e.g., just schedule a redraw).
export class Watcher implements Disposable {
  private _callback: () => void;
  private _notified: boolean = false;
  _disposed: boolean = false;
  private _watching: Set<SignalBase<unknown>> = new Set();
  readonly _selfRef: WeakRef<Watcher>;

  constructor(notify: () => void) {
    this._callback = notify;
    this._selfRef = new WeakRef(this);
  }

  // Also resets the notified flag, allowing the callback to fire again.
  watch(...signals: SignalBase<unknown>[]): void {
    for (const signal of signals) {
      if (!signal._sinks) continue; // ConstSignal has no sinks
      signal._sinks.add(this._selfRef);
      this._watching.add(signal);
    }
    this._notified = false;
  }

  unwatch(...signals: SignalBase<unknown>[]): void {
    for (const signal of signals) {
      if (!signal._sinks) continue;
      signal._sinks.delete(this._selfRef);
      this._watching.delete(signal);
    }
  }

  // Only ComputedSignals can be dirty/checking; StateSignals are always current.
  getPending(): SignalBase<unknown>[] {
    const pending: SignalBase<unknown>[] = [];
    for (const signal of this._watching) {
      if (signal instanceof ComputedSignal) {
        if (signal._state !== ComputedState.Clean) {
          pending.push(signal);
        }
      }
    }
    return pending;
  }

  _notify(): void {
    if (this._disposed || this._notified) return;
    this._notified = true;

    // Clear computing context so Watcher reads don't register as dependencies
    // of whatever ComputedSignal is currently being evaluated.
    const prevComputing = computing;
    computing = null;
    try {
      this._callback();
    } finally {
      computing = prevComputing;
    }
  }

  [Symbol.dispose](): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const signal of this._watching) {
      signal._sinks?.delete(this._selfRef);
    }
    this._watching.clear();
  }
}

// Safe signal wrappers that hide internal properties via Proxy.
// Exposed to user scripts as Signal.State, Signal.Computed, and Signal.Const.
class SafeConstSignal<T> extends ConstSignal<T> {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return instance instanceof ConstSignal;
  }

  constructor(value: T) {
    super(value);
    return createSafeProxy(this);
  }
}

class SafeStateSignal<T> extends StateSignal<T> {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return instance instanceof StateSignal;
  }

  constructor(initialValue: T, options?: SignalOptions<T>) {
    super(initialValue, options);
    return createSafeProxy(this);
  }
}

class SafeComputedSignal<T> extends ComputedSignal<T> {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return instance instanceof ComputedSignal;
  }

  constructor(callback: () => T, options?: SignalOptions<T>) {
    super(callback, options);
    return createSafeProxy(this);
  }
}

export const Signal = {
  Const: SafeConstSignal,
  State: SafeStateSignal,
  Computed: SafeComputedSignal,
  [Symbol.hasInstance](instance: unknown): boolean {
    return instance instanceof SignalBase;
  },
};

// setTimeout wrapper that skips the callback if the owning computed is no longer
// valid when the timeout fires, and re-establishes that computed as the ambient
// cleanup owner around the callback — so a resource it creates (a global
// addEventListener, a nested timer, a signal) anchors to the owner instead of
// leaking. Outside a cleanup owner, behaves like globalThis.setTimeout.
export function setTimeout<TArgs extends unknown[]>(
  callback: (...callbackArgs: TArgs) => void,
  delay?: number,
  ...args: TArgs
): ReturnType<typeof globalThis.setTimeout> {
  const signal = currentCleanupOwner();

  if (signal === null) {
    return globalThis.setTimeout(callback, delay, ...args);
  }

  const timeoutId = globalThis.setTimeout(
    (...callbackArgs: TArgs) => {
      // If the owner was invalidated/disposed before this fired, skip. A one-shot
      // has nothing recurring to stop (the registered cleanup clears a pending id
      // on disposal/recompute); this guard only covers the fire-before-cleanup
      // race. Contrast setInterval, which must actively clear (see below).
      if (signal._isValid()) {
        runWithCleanupOwner(signal, () => callback(...callbackArgs));
      }
    },
    delay,
    ...args,
  );
  registerCleanup(() => globalThis.clearTimeout(timeoutId));
  return timeoutId;
}

// setInterval wrapper that clears the interval when the owning computed becomes
// dirty or is recomputed, and re-establishes that computed as the ambient
// cleanup owner around each tick (see setTimeout above). Outside a cleanup owner,
// behaves like globalThis.setInterval.
export function setInterval<TArgs extends unknown[]>(
  callback: (...callbackArgs: TArgs) => void,
  delay?: number,
  ...args: TArgs
): ReturnType<typeof globalThis.setInterval> {
  const signal = currentCleanupOwner();

  if (signal === null) {
    return globalThis.setInterval(callback, delay, ...args);
  }

  const intervalId = globalThis.setInterval(
    (...callbackArgs: TArgs) => {
      if (signal._isValid()) {
        runWithCleanupOwner(signal, () => callback(...callbackArgs));
      } else {
        // An interval recurs, so stop it here. The owner may be invalidated yet
        // not recomputed (recompute is lazy/pull-based), so its registered
        // clearInterval cleanup hasn't run; without this the interval would keep
        // ticking as a no-op until something pulls the owner's value.
        globalThis.clearInterval(intervalId);
      }
    },
    delay,
    ...args,
  );
  registerCleanup(() => globalThis.clearInterval(intervalId));
  return intervalId;
}
