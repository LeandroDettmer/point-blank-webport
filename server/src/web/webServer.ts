// The one HTTP/WebSocket front of the TS servers (port 8090):
//   ws://HOST:PORT/tcp?target=auth|game1|game2|game3  -> 1 WebSocket = 1 PB session, straight into Auth/Game (no TCP hop)
//   ws://HOST:PORT/signal?room=&role=&slot=           -> WebRTC signaling of the leader-hosted match (signal.ts)
//   GET  /health                                      -> JSON with live session counts
//   POST /api/register, POST /api/login               -> account HTTP API (bcrypt + Postgres, ./accounts)
import http from "node:http";
import type net from "node:net";
import { WebSocketServer } from "ws";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { handleSignal, signalStats } from "./signal.ts";
import { credentialsSchema } from "./accounts/validation.ts";
import { registerAccount, loginAccount, AccountApiError } from "./accounts/accounts.ts";
import { isRateLimited } from "./accounts/rateLimit.ts";
import { WsSocket } from "./wsSocket.ts";
import { IpCap } from "./guard.ts";

/** target name ("auth", "game1".."game3") -> session acceptor of that server */
export type Acceptors = Record<string, (sock: net.Socket) => void>;

const log = (msg: string) => console.log(`${new Date().toISOString()} [web] ${msg}`);
const live = { tcp: 0 };

// Own table, does not touch the server's accounts schema. Holds the real password hash for the web account flow;
// accounts.password stays a throwaway value since the game server only authenticates by token.
export async function ensureAccountSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_api_credentials (
      username varchar(16) PRIMARY KEY,
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

// CORS stays restricted for browser callers not served from vite (port 8000/8001), plus the exact PB_WEB_ORIGINS (prod).
const API_ALLOWED_ORIGIN_RE = /^https?:\/\/[^/]+:800[01]$/;
export const isAllowedOrigin = (origin: string, extra: readonly string[] = config.webOrigins): boolean =>
  API_ALLOWED_ORIGIN_RE.test(origin) || extra.includes(origin);

/** Client IP: the socket peer, or with PB_TRUST_PROXY the last X-Forwarded-For entry (the hop Cloud Run itself saw;
 * earlier entries are whatever the caller sent). Feeds the per-IP cap, the /api rate limit and the Auth throttle. */
export function clientIp(req: http.IncomingMessage, trustProxy = config.trustProxy): string {
  const xff = req.headers["x-forwarded-for"];
  const last = trustProxy ? (Array.isArray(xff) ? xff.join(",") : xff ?? "").split(",").map((x) => x.trim()).filter(Boolean).pop() : undefined;
  return last ?? req.socket.remoteAddress ?? "";
}

function setApiCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    size += (chunk as Buffer).length;
    if (size > 1024) throw new AccountApiError(413, "body too large");
  }
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  try {
    return JSON.parse(raw);
  } catch {
    throw new AccountApiError(400, "invalid JSON body");
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
  const ip = clientIp(req) || "unknown";
  try {
    if (req.method === "POST" && pathname === "/api/register") {
      if (isRateLimited(`register:${ip}`)) throw new AccountApiError(429, "too many requests, slow down");
      const body = credentialsSchema.parse(await readJsonBody(req));
      sendJson(res, 201, await registerAccount(body.username, body.password));
      return;
    }
    if (req.method === "POST" && pathname === "/api/login") {
      if (isRateLimited(`login:${ip}`)) throw new AccountApiError(429, "too many requests, slow down");
      const body = credentialsSchema.parse(await readJsonBody(req));
      sendJson(res, 200, await loginAccount(body.username, body.password));
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    if (err instanceof AccountApiError) {
      sendJson(res, err.status, { error: err.message });
      return;
    }
    if (err && typeof err === "object" && "issues" in err) {
      sendJson(res, 400, { error: "validation failed", details: (err as { issues: unknown }).issues });
      return;
    }
    console.error(err);
    sendJson(res, 500, { error: "internal error" });
  }
}

export async function startWebServer(acceptors: Acceptors, host = config.webHost, port = config.webPort): Promise<http.Server> {
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ ok: true, targets: Object.keys(acceptors), live, signal: signalStats() }));
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      setApiCors(req, res);
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      void handleApi(req, res, url.pathname);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("web front: use ws /tcp?target=auth|game1..3, /signal?room=&role=&slot= or POST /api/register|login\n");
  });

  // maxPayload: a PB frame / UDP datagram / signaling message is far below 64 KiB (ws defaults to 100 MiB)
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });
  const ipCap = new IpCap(config.webMaxConnPerIp);
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const target = url.searchParams.get("target") ?? "";
    const refuse = (line = "404 Not Found") => { socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    const ip = clientIp(req);
    const known = url.pathname === "/signal" || (url.pathname === "/tcp" && acceptors[target]);
    if (!known) { refuse(); return; }
    // with PB_WEB_ORIGINS set (prod) a page of any other site is refused; no Origin header = not a browser (tools, tests)
    const origin = req.headers.origin;
    if (config.webOrigins.length && origin && !isAllowedOrigin(origin)) { log(`ws origin refused: ${origin}`); refuse("403 Forbidden"); return; }
    if (!ipCap.acquire(ip)) { log(`too many connections from ${ip}`); refuse("429 Too Many Requests"); return; }
    socket.once("close", () => ipCap.release(ip));
    if (url.pathname === "/signal") {
      wss.handleUpgrade(req, socket, head, (ws) => handleSignal(ws, url, log));
    } else if (url.pathname === "/tcp" && acceptors[target]) {
      const accept = acceptors[target];
      wss.handleUpgrade(req, socket, head, (ws) => {
        live.tcp++;
        const sock = new WsSocket(ws, ip);
        sock.on("close", () => live.tcp--);
        accept(sock as unknown as net.Socket);
      });
    } else {
      refuse();
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });
  log(`listening on ${host}:${port} (tcp targets: ${Object.keys(acceptors).join(", ")})`);
  return httpServer;
}
