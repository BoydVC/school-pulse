export interface LiveHooks {
  /** Catch up with the server. The pill turns on only after this resolves. */
  refresh: () => void | Promise<unknown>;
  setConnected: (on: boolean) => void;
  /** Open a fresh stream. Called after the current one goes silent. */
  reconnect?: () => void;
}

export interface LiveTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

/** The server pings every 25 s. Two missed pings plus slack means the stream is dead. */
export const SILENCE_MS = 55_000;

const defaultTimers: LiveTimers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms) as unknown as { unref?: () => void };
    handle.unref?.(); // Node only; browsers return a number.
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface LiveSocket {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  close?: () => void;
  addEventListener?: (type: string, listener: () => void) => void;
}

export function attachLiveStream(
  events: { onopen: unknown; onerror: unknown },
  hooks: LiveHooks,
  timers: LiveTimers = defaultTimers,
  silenceMs: number = SILENCE_MS,
): { heard: () => void; close: () => void } {
  const socket = events as LiveSocket;
  let silence: unknown = null;
  let closed = false;
  let openSeq = 0;

  const stopTimer = (): void => {
    if (silence !== null) timers.clear(silence);
    silence = null;
  };
  const close = (): void => {
    closed = true;
    stopTimer();
    socket.close?.();
  };
  const heard = (): void => {
    if (closed) return;
    stopTimer();
    silence = timers.set(() => {
      if (closed) return;
      hooks.setConnected(false);
      close();
      hooks.reconnect?.();
    }, silenceMs);
  };

  socket.onopen = () => {
    const seq = ++openSeq;
    heard();
    // Pulses published while the stream was down were not buffered. Catch up first,
    // and only then call the page live.
    Promise.resolve()
      .then(() => hooks.refresh())
      .catch(() => undefined)
      .then(() => {
        if (!closed && seq === openSeq) hooks.setConnected(true);
      });
  };
  socket.onerror = () => {
    hooks.setConnected(false);
  };
  socket.addEventListener?.("pulse", heard);
  socket.addEventListener?.("ping", heard);
  heard();
  return { heard, close };
}

export function shouldRefreshOnVisibility(state: string): boolean {
  return state === "visible";
}
