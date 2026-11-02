export interface AuthSession {
  fetchImpl: typeof fetch;
  token: string;
  refreshed: boolean;
  onUnauthorized?: () => Promise<string>;
}

export function createSession(options: {
  token: string;
  fetchImpl?: typeof fetch;
  onUnauthorized?: () => Promise<string>;
}): AuthSession {
  return {
    fetchImpl: options.fetchImpl ?? fetch,
    token: options.token,
    refreshed: false,
    onUnauthorized: options.onUnauthorized,
  };
}

/** GET with one refresh-and-retry when the source answers 401. */
export async function authorizedGet(session: AuthSession, url: string, accept: string, label: "Classroom" | "Graph"): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`${label} sync only uses https GET`);
  const once = (): Promise<Response> => session.fetchImpl(url, {
    method: "GET",
    headers: { authorization: `Bearer ${session.token}`, accept },
  });
  let response = await once();
  if (response.status !== 401) return response;
  if (!session.onUnauthorized || session.refreshed) throw new Error(`${label} GET 401`);
  session.refreshed = true;
  const next = await session.onUnauthorized();
  if (!next) throw new Error(`${label} GET 401`);
  session.token = next;
  response = await once();
  if (response.status === 401) throw new Error(`${label} GET 401`);
  return response;
}
