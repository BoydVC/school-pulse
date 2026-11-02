import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseSnapshot } from "../adapters/index.js";
import { deliverWebhooks, readAlerts, saveRules, setWebhook } from "../alerts/alerts.js";
import { buildDashboard } from "../dashboard/build.js";
import { ingestSnapshot } from "../ingest/ingest.js";
import type { AlertRuleType } from "../model/types.js";
import type { DatabaseSync } from "node:sqlite";
import { repoRoot } from "../util/root.js";
import { createHub, type Hub } from "./hub.js";

export interface RunningServer {
  url: string;
  port: number;
  hub: Hub;
  close: () => Promise<void>;
}

const RULE_TYPES = new Set<AlertRuleType>(["grade_below", "missing_above", "grade_drop"]);

export async function startServer(options: {
  db: DatabaseSync;
  host?: string;
  port?: number;
  hub?: Hub;
}): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4173;
  const hub = options.hub ?? createHub();
  const root = repoRoot();
  const web = join(root, "web");
  const appJs = join(root, "dist", "web", "app.js");
  const heartbeats = new Set<NodeJS.Timeout>();
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
      const message = error instanceof Error ? error.message : "Request failed";
      sendJson(res, Number.isFinite(status) ? status : 500, { ok: false, error: message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${host}`);
    const method = req.method ?? "GET";
    if (method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === "GET" && url.pathname === "/api/dashboard") {
      sendJson(res, 200, buildDashboard(options.db, new Date()));
      return;
    }
    if (method === "GET" && url.pathname === "/api/alerts") {
      sendJson(res, 200, readAlerts(options.db, new Date()));
      return;
    }
    if (method === "PUT" && url.pathname === "/api/alerts/rules") {
      const body = JSON.parse(await readBody(req)) as { rules?: unknown };
      if (!Array.isArray(body.rules)) throw badRequest("Expected { rules: [] }");
      const rules = body.rules.map((rule) => parseRule(rule));
      saveRules(options.db, rules, new Date());
      const alerts = readAlerts(options.db, new Date());
      sendJson(res, 200, alerts);
      return;
    }
    if (method === "PUT" && url.pathname === "/api/alerts/webhook") {
      const body = JSON.parse(await readBody(req)) as { url?: unknown };
      const webhook = body.url == null || body.url === "" ? null : body.url;
      if (webhook != null && typeof webhook !== "string") throw badRequest("Webhook url must be a string.");
      setWebhook(options.db, webhook);
      sendJson(res, 200, { ok: true, webhook });
      return;
    }
    if (method === "POST" && url.pathname === "/api/ingest") {
      const rawBody = await readBody(req);
      const payload = readIngestPayload(url, req.headers["content-type"] ?? "", rawBody);
      const now = new Date();
      let snapshot;
      try {
        snapshot = parseSnapshot({ source: payload.source, filename: payload.filename, raw: payload.raw, now });
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : "Could not read snapshot");
      }
      const result = ingestSnapshot(options.db, snapshot, now);
      await deliverWebhooks(options.db, result.alerts).catch((error: unknown) => {
        console.error(`school-pulse: webhook failed: ${error instanceof Error ? error.message : "unknown"}`);
      });
      hub.publish(result);
      sendJson(res, 200, {
        ok: true,
        unchanged: result.unchanged,
        assignmentsInserted: result.assignmentsInserted,
        assignmentsUpdated: result.assignmentsUpdated,
        gradesInserted: result.gradesInserted,
        changes: result.changes.map((change) => ({ id: change.id, summary: change.summary, kind: change.kind })),
        alerts: result.alerts.map((alert) => ({ id: alert.id, summary: alert.summary })),
      });
      return;
    }
    if (method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      res.write(": ok\n\n");
      hub.add(res);
      const timer = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          clearInterval(timer);
        }
      }, 25_000);
      heartbeats.add(timer);
      res.on("close", () => {
        clearInterval(timer);
        heartbeats.delete(timer);
        hub.remove(res);
      });
      return;
    }
    if (method === "GET") {
      await serveStatic(res, url.pathname, web, appJs);
      return;
    }
    sendJson(res, 404, { ok: false, error: "Not found" });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  return {
    url: `http://${host}:${actual}`,
    port: actual,
    hub,
    close: () => closeServer(server, heartbeats),
  };
}

function closeServer(server: Server, heartbeats: Set<NodeJS.Timeout>): Promise<void> {
  for (const timer of heartbeats) clearInterval(timer);
  heartbeats.clear();
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function serveStatic(res: ServerResponse, pathname: string, web: string, appJs: string): Promise<void> {
  if (pathname === "/app.js") {
    await sendFile(res, appJs, "text/javascript; charset=utf-8");
    return;
  }
  if (pathname === "/styles.css") {
    await sendFile(res, join(web, "styles.css"), "text/css; charset=utf-8");
    return;
  }
  if (pathname.startsWith("/fonts/")) {
    const name = basename(pathname);
    if (!name.endsWith(".woff2")) {
      sendJson(res, 404, { ok: false, error: "Not found" });
      return;
    }
    await sendFile(res, join(web, "fonts", name), "font/woff2");
    return;
  }
  if (pathname === "/" || pathname === "/index.html") {
    await sendFile(res, join(web, "index.html"), "text/html; charset=utf-8");
    return;
  }
  sendJson(res, 404, { ok: false, error: "Not found" });
}

async function sendFile(res: ServerResponse, file: string, type: string): Promise<void> {
  if (!existsSync(file)) {
    sendJson(res, 404, { ok: false, error: "Not found" });
    return;
  }
  res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
  await pipeline(createReadStream(file), res);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage, limit = 5_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(badRequest("Body too large", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function readIngestPayload(url: URL, contentType: string, body: string): { source: string | null; filename: string; raw: string } {
  const querySource = url.searchParams.get("source");
  const filename = url.searchParams.get("filename") ?? "upload.json";
  if (querySource) return { source: querySource, filename, raw: body };
  if (contentType.includes("json")) {
    try {
      const parsed = JSON.parse(body) as { source?: unknown; body?: unknown; filename?: unknown };
      if (typeof parsed.body === "string" && typeof parsed.source === "string") {
        return {
          source: parsed.source,
          filename: typeof parsed.filename === "string" ? parsed.filename : filename,
          raw: parsed.body,
        };
      }
    } catch {
      // The body itself is the snapshot.
    }
  }
  return { source: null, filename, raw: body };
}

function parseRule(value: unknown): { id?: string; enabled: boolean; type: AlertRuleType; threshold: number; studentName: string | null } {
  if (!value || typeof value !== "object") throw badRequest("Invalid rule");
  const rule = value as { id?: unknown; enabled?: unknown; type?: unknown; threshold?: unknown; studentName?: unknown };
  if (typeof rule.type !== "string" || !RULE_TYPES.has(rule.type as AlertRuleType)) throw badRequest("Unknown alert rule type");
  if (typeof rule.threshold !== "number" || !Number.isFinite(rule.threshold)) throw badRequest("Rule threshold must be a number");
  return {
    id: typeof rule.id === "string" ? rule.id : undefined,
    enabled: rule.enabled === true,
    type: rule.type as AlertRuleType,
    threshold: rule.threshold,
    studentName: typeof rule.studentName === "string" ? rule.studentName : null,
  };
}

function badRequest(message: string, status = 400): Error {
  return Object.assign(new Error(message), { status });
}
