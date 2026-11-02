import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { explainIngest, ingestText, type IngestOutcome } from "../ingest/ingest.ts";
import { parseRuleList } from "../alerts/engine.ts";
import { instantFromDate, type IsoInstant, type Source } from "../domain/index.ts";
import { Store } from "../store/store.ts";
import { dashboard, isSource } from "./view.ts";

export type RunningServer = {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
  broadcast(payload: IngestOutcome): void;
  ingest(source: Source, text: string, filename: string): Promise<IngestOutcome | { readonly error: string }>;
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".png": "image/png",
};

export async function startServer(options: {
  readonly store: Store;
  readonly port: number;
  readonly publicDir: string;
  readonly now?: () => IsoInstant;
  readonly postWebhook?: (url: string, body: string) => Promise<void>;
}): Promise<RunningServer> {
  const now = options.now ?? (() => instantFromDate(new Date()));
  const clients = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    try {
      await route(request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "request failed";
      sendJson(response, 400, { error: message });
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    if (request.method === "GET" && path === "/api/health") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && path === "/api/household") {
      sendJson(response, 200, dashboard(options.store, now()));
      return;
    }
    if (request.method === "GET" && path === "/api/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-content-type-options": "nosniff",
      });
      response.write(": connected\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    if (request.method === "POST" && path === "/api/ingest") {
      const body = JSON.parse(await readBody(request)) as unknown;
      if (!isRecord(body) || typeof body["source"] !== "string" || typeof body["filename"] !== "string" || typeof body["text"] !== "string") {
        sendJson(response, 400, { error: "ingest needs source, filename, and text" });
        return;
      }
      if (!isSource(body["source"])) {
        sendJson(response, 400, { error: "unknown source" });
        return;
      }
      const result = await ingestAndBroadcast(body["source"], body["text"], body["filename"]);
      sendJson(response, "error" in result ? 400 : 200, result);
      return;
    }
    if (request.method === "GET" && path === "/api/alerts/rules") {
      sendJson(response, 200, { rules: options.store.rules() });
      return;
    }
    if (request.method === "PUT" && path === "/api/alerts/rules") {
      const body = JSON.parse(await readBody(request)) as unknown;
      const rules = parseRuleList(isRecord(body) ? body["rules"] : body);
      if (typeof rules === "string") {
        sendJson(response, 400, { error: rules });
        return;
      }
      options.store.saveRules(rules);
      sendJson(response, 200, { rules: options.store.rules() });
      return;
    }
    if (request.method === "GET" && path === "/api/alerts") {
      sendJson(response, 200, { alerts: options.store.alerts() });
      return;
    }
    if (request.method === "GET" && path === "/api/alerts/webhook") {
      sendJson(response, 200, options.store.webhook());
      return;
    }
    if (request.method === "PUT" && path === "/api/alerts/webhook") {
      const body = JSON.parse(await readBody(request)) as unknown;
      if (!isRecord(body) || typeof body["enabled"] !== "boolean") {
        sendJson(response, 400, { error: "webhook needs enabled" });
        return;
      }
      const rawUrl = body["url"];
      const url = typeof rawUrl === "string" && rawUrl.length > 0 ? rawUrl : null;
      if (url !== null && !/^https?:\/\//.test(url)) {
        sendJson(response, 400, { error: "webhook url must be http(s)" });
        return;
      }
      options.store.setWebhook(url, body["enabled"]);
      sendJson(response, 200, options.store.webhook());
      return;
    }
    if (request.method === "GET") {
      const relative = (path === "/" ? "index.html" : path).replace(/^\/+/, "");
      if (relative.includes("..") || relative.includes("\0")) {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      const file = join(options.publicDir, relative);
      try {
        const payload = readFileSync(file);
        response.writeHead(200, {
          "content-type": TYPES[extname(file)] ?? "application/octet-stream",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(payload);
      } catch {
        sendJson(response, 404, { error: "not found" });
      }
      return;
    }
    sendJson(response, 405, { error: "method not allowed" });
  }

  async function ingestAndBroadcast(source: Source, text: string, filename: string): Promise<IngestOutcome | { error: string }> {
    const result = await ingestText(options.store, source, text, filename, now(), {
      ...(options.postWebhook ? { postWebhook: options.postWebhook } : {}),
    });
    if (!result.ok) return { error: explainIngest(result.error) };
    if (result.value.outcome === "applied") broadcast(result.value);
    return result.value;
  }

  function broadcast(payload: IngestOutcome): void {
    if (payload.outcome !== "applied") return;
    const data = `event: ingest\ndata: ${JSON.stringify({
      source: payload.source,
      messages: payload.messages,
      changeIds: payload.changeIds,
    })}\n\n`;
    for (const client of clients) client.write(data);
  }

  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": ping\n\n");
  }, 25000);
  heartbeat.unref?.();

  await new Promise<void>((resolve) => {
    server.listen(options.port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    broadcast,
    ingest: ingestAndBroadcast,
    async close() {
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2_000_000) throw new Error("body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
