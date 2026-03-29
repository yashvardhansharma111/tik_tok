type SessionEntry = {
  browser: import("playwright").Browser;
  context: import("playwright").BrowserContext;
};

const store = new Map<string, SessionEntry>();

export function set(sessionId: string, entry: SessionEntry) {
  store.set(sessionId, entry);
}

export function get(sessionId: string): SessionEntry | undefined {
  return store.get(sessionId);
}

export function remove(sessionId: string) {
  store.delete(sessionId);
}

export function getAnySessionId(): string | null {
  const keys = Array.from(store.keys());
  return keys.length > 0 ? keys[0] : null;
}
