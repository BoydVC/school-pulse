export interface LiveSocket {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
}

export interface LiveHooks {
  refresh: () => void;
  setConnected: (on: boolean) => void;
}

export function attachLiveStream(events: LiveSocket, hooks: LiveHooks): void {
  events.onopen = () => {
    hooks.setConnected(true);
  };
  events.onerror = () => {
    hooks.setConnected(false);
  };
}

export function shouldRefreshOnVisibility(state: string): boolean {
  return state === "hidden";
}
