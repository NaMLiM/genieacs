import { StateSignal } from "./signals.ts";

export interface Notification {
  type: string;
  message: string;
  timestamp: number;
  actions?: { [label: string]: () => void };
}

const notificationsSignal = new StateSignal<Notification[]>([]);

export function push(
  type: string,
  message: string,
  actions?: { [label: string]: () => void },
): Notification {
  const n: Notification = {
    type: type,
    message: message,
    timestamp: Date.now(),
    actions: actions,
  };
  notificationsSignal.update((list) => [...list, n]);
  if (!actions) {
    setTimeout(() => {
      dismiss(n);
    }, 4000);
  }

  return n;
}

export function dismiss(n: Notification): void {
  notificationsSignal.update((list) => list.filter((x) => x !== n));
}

export function getSignal(): StateSignal<Notification[]> {
  return notificationsSignal;
}
