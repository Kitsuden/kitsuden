/**
 * useSyncedState — the server's live state, in React
 * ============================================================================
 *
 * Closes the loop with the primitive that drives the OBS overlay: the same
 * channel, the same message, the same defense against late messages — but
 * consumed from a component.
 *
 * It relies on `useSyncExternalStore`, the API React 18+ provides for exactly
 * this. Doing it with `useState` + `useEffect` produces tearing in concurrent
 * mode: two components subscribed to the same channel can paint different
 * values in the same frame.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

/** Message that travels over the channel. Same as the server's. */
export interface SyncedStateMessage<T = unknown> {
  type: "state:sync";
  key: string;
  revision: number;
  value: T;
}

export interface SyncedStateOptions<T> {
  /** Value while nothing has arrived yet. */
  initial?: T | null;
  /** WebSocket URL. Defaults to the same host. */
  socketUrl?: string;
  /** Initial snapshot, to avoid starting blank. */
  fetchSnapshot?: () => Promise<{ value: T; revision: number } | null>;
  /** Automatic reconnection. Defaults to `true`. */
  reconnect?: boolean;
}

export interface SyncedStateResult<T> {
  value: T | null;
  revision: number;
  connected: boolean;
  error: Error | null;
}

/** One store per key: several components on the same channel share a socket. */
interface Store<T> {
  value: T | null;
  revision: number;
  connected: boolean;
  error: Error | null;
  listeners: Set<() => void>;
  socket: WebSocket | null;
  refCount: number;
  retry: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Immutable snapshot for `useSyncExternalStore`. */
  snapshot: SyncedStateResult<T>;
}

const stores = new Map<string, Store<unknown>>();

function emit<T>(store: Store<T>) {
  // NEW snapshot on every change: `useSyncExternalStore` compares by
  // identity, and mutating the same object would make React never repaint.
  store.snapshot = {
    value: store.value,
    revision: store.revision,
    connected: store.connected,
    error: store.error,
  };
  for (const listener of store.listeners) listener();
}

function defaultSocketUrl(channel: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws?channel=${encodeURIComponent(channel)}`;
}

function connect<T>(key: string, store: Store<T>, options: SyncedStateOptions<T>) {
  if (typeof window === "undefined") return; // SSR: there is no WebSocket
  if (store.socket) return;

  const channel = `state:${key}`;
  let socket: WebSocket;
  try {
    socket = new WebSocket(options.socketUrl ?? defaultSocketUrl(channel));
  } catch (err) {
    store.error = err instanceof Error ? err : new Error(String(err));
    emit(store);
    return scheduleReconnect(key, store, options);
  }

  store.socket = socket;

  socket.addEventListener("open", () => {
    store.retry = 0;
    store.connected = true;
    store.error = null;
    socket.send(JSON.stringify({ type: "subscribe", channel }));
    emit(store);

    // On (re)connect, whatever happened in the meantime was lost.
    void options.fetchSnapshot?.().then((snap) => {
      if (!snap) return;
      // The snapshot may be OLDER than what has already arrived over the socket.
      if (snap.revision <= store.revision) return;
      store.value = snap.value;
      store.revision = snap.revision;
      emit(store);
    });
  });

  socket.addEventListener("message", (event) => {
    try {
      const raw = JSON.parse(event.data as string);
      const message = (raw?.message ?? raw) as SyncedStateMessage<T>;
      if (message?.type !== "state:sync" || message.key !== key) return;

      // The defense that matters: a late message after a reconnection must NOT
      // overwrite a newer state.
      if (typeof message.revision === "number" && message.revision <= store.revision) return;

      store.value = message.value;
      store.revision = message.revision;
      emit(store);
    } catch {
      // An unreadable message must not take down the subscription.
    }
  });

  socket.addEventListener("close", () => {
    store.socket = null;
    store.connected = false;
    emit(store);
    if (options.reconnect !== false && store.refCount > 0) {
      scheduleReconnect(key, store, options);
    }
  });

  socket.addEventListener("error", () => {
    try {
      socket.close();
    } catch {
      /* the close already triggers the reconnection */
    }
  });
}

/** Exponential backoff with a ceiling, and only if someone is still subscribed. */
function scheduleReconnect<T>(key: string, store: Store<T>, options: SyncedStateOptions<T>) {
  if (store.timer || store.refCount === 0) return;
  const delay = Math.min(500 * 2 ** store.retry++, 10_000);
  store.timer = setTimeout(() => {
    store.timer = null;
    if (store.refCount > 0) connect(key, store, options);
  }, delay);
}

/**
 * Subscribes to the synced state of a key.
 *
 *   const { value, connected } = useSyncedState<Overlay>("broadcast:match:42", {
 *     fetchSnapshot: async () => {
 *       const r = await fetch("/api/broadcast/overlay/42").then((r) => r.json());
 *       return { value: r.data, revision: r.revision };
 *     },
 *   });
 *
 * Several components with the same key **share a single socket**: without that,
 * a list of ten scoreboards would open ten connections.
 */
export function useSyncedState<T = unknown>(
  key: string,
  options: SyncedStateOptions<T> = {}
): SyncedStateResult<T> {
  // Options are read through a ref: passing them as an object literal (the usual
  // case) would change identity on every render and reconnect endlessly.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const store = useMemo(() => {
    let existing = stores.get(key) as Store<T> | undefined;
    if (!existing) {
      const initial = optionsRef.current.initial ?? null;
      existing = {
        value: initial,
        revision: -1,
        connected: false,
        error: null,
        listeners: new Set(),
        socket: null,
        refCount: 0,
        retry: 0,
        timer: null,
        snapshot: { value: initial, revision: -1, connected: false, error: null },
      };
      stores.set(key, existing as Store<unknown>);
    }
    return existing;
  }, [key]);

  const subscribe = useCallback(
    (listener: () => void) => {
      store.listeners.add(listener);
      store.refCount++;
      if (store.refCount === 1) connect(key, store, optionsRef.current);

      return () => {
        store.listeners.delete(listener);
        store.refCount--;
        // It closes only when NOBODY is subscribed any more. Closing when the first
        // component unmounts would cut the channel for the others.
        if (store.refCount === 0) {
          if (store.timer) {
            clearTimeout(store.timer);
            store.timer = null;
          }
          store.socket?.close();
          store.socket = null;
        }
      };
    },
    [key, store]
  );

  const getSnapshot = useCallback(() => store.snapshot, [store]);

  // On the server there is no socket: the initial snapshot is returned so that
  // the SSR/RSC render does not fail or desynchronize hydration.
  const getServerSnapshot = useCallback(
    () => ({
      value: optionsRef.current.initial ?? null,
      revision: -1,
      connected: false,
      error: null,
    }),
    []
  );

  useEffect(() => {
    // Retries if the tab returns to the foreground with the socket down.
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible" && !store.socket && store.refCount > 0) {
        connect(key, store, optionsRef.current);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [key, store]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Forgets the stores. For tests only. */
export function resetSyncedStateStores(): void {
  for (const store of stores.values()) {
    if (store.timer) clearTimeout(store.timer);
    store.socket?.close();
  }
  stores.clear();
}
