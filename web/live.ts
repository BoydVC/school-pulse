export interface LiveHooks {
  refresh: () => void;
  setConnected: (on: boolean) => void;
}

export function attachLiveStream(events: { onopen: unknown; onerror: unknown }, hooks: LiveHooks): void {
  const socket = events as { onopen: (() => void) | null; onerror: (() => void) | null };
  let opened = false;
  socket.onopen = () => {
    const reconnect = opened;
    opened = true;
    hooks.setConnected(true);
    if (reconnect) hooks.refresh();
  };
  socket.onerror = () => {
    hooks.setConnected(false);
  };
}

export function shouldRefreshOnVisibility(state: string): boolean {
  return state === "visible";
}
