import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAlerts } from './alerts.js';
import { ingestFile, ingestInbox, ingestText, watchInbox } from './ingest.js';
import { isSource } from './model.js';
import { staleHours } from './paths.js';
import type { ChangeRow, Store } from './store.js';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.png': 'image/png',
};

export interface RunningServer {
  server: Server;
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startServer(options: {
  store: Store;
  inbox: string;
  port?: number;
  host?: string;
}): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const clients = new Set<ServerResponse>();
  ingestInbox(options.store, options.inbox);
  const watcher = watchInbox(options.inbox, (file) => {
    const report = ingestFile(options.store, file);
    if (report.error) {
      broadcast(clients, { type: 'error', file, message: report.error });
      return;
    }
    if (report.unchanged) return;
    void evaluateAlerts(options.store, report.changes).finally(() => {
      broadcast(clients, { type: 'update', changes: report.changes, file });
    });
  });

  const server = createServer(async (req, res) => {
    if (!isLoopback(req)) {
      sendJson(res, 403, { error: 'School Pulse only accepts local connections' });
      return;
    }
    try {
      await route(req, res, options.store, clients);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Server error';
      sendJson(res, 500, { error: message });
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolveListen());
  });
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  return {
    server,
    port: bound,
    url: `http://${host}:${bound}`,
    close: () => new Promise((resolveClose) => {
      watcher.close();
      for (const client of clients) client.end();
      server.closeAllConnections();
      server.close(() => resolveClose());
    }),
  };
}

async function route(req: IncomingMessage, res: ServerResponse, store: Store, clients: Set<ServerResponse>): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    sendJson(res, 200, store.state(new Date(), staleHours()));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('event: pulse\ndata: {"type":"hello"}\n\n');
    clients.add(res);
    const timer = setInterval(() => res.write(': keepalive\n\n'), 25000);
    req.on('close', () => {
      clearInterval(timer);
      clients.delete(res);
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/ingest') {
    const body = await readBody(req);
    const hintRaw = url.searchParams.get('source');
    const hint = hintRaw && isSource(hintRaw) ? hintRaw : null;
    const report = ingestText(store, body, hint, 'api');
    if (report.error) {
      sendJson(res, 400, report);
      return;
    }
    const alerts = await evaluateAlerts(store, report.changes);
    if (!report.unchanged) broadcast(clients, { type: 'update', changes: report.changes });
    sendJson(res, 200, { ...report, alerts });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/alerts/rules') {
    sendJson(res, 200, { rules: store.listAlertRules(), events: store.listAlertEvents() });
    return;
  }
  if (req.method === 'PUT' && url.pathname === '/api/alerts/rules') {
    const body = JSON.parse(await readBody(req)) as { rules?: { id: string; kind: string; threshold: number; enabled?: boolean; webhook?: string | null; student_id?: string | null }[] };
    const rules = (body.rules ?? []).map((rule) => ({
      id: rule.id,
      kind: rule.kind,
      threshold: Number(rule.threshold),
      enabled: Boolean(rule.enabled),
      webhook: rule.webhook ?? null,
      student_id: rule.student_id ?? null,
    }));
    store.saveAlertRules(rules);
    sendJson(res, 200, { rules: store.listAlertRules() });
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets') || isStatic(url.pathname))) {
    serveStatic(res, url.pathname);
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
}

function isStatic(pathname: string): boolean {
  return pathname === '/styles.css' || pathname === '/app.js' || pathname === '/index.html';
}

function serveStatic(res: ServerResponse, pathname: string): void {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(PUBLIC_DIR, requested));
  if (!file.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  const stream = createReadStream(file);
  stream.on('error', () => sendJson(res, 404, { error: 'Not found' }));
  stream.on('open', () => {
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  });
  stream.pipe(res);
}

function broadcast(clients: Set<ServerResponse>, payload: { type: string; changes?: ChangeRow[]; file?: string; message?: string }): void {
  const data = `event: pulse\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(data);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(raw) });
  res.end(raw);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 5_000_000) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
