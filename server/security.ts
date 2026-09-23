// Network-exposure guards for the Claw-Kanban API: loopback detection, origin allowlist
// (CORS + cross-origin write blocking), Host-header check against DNS rebinding, and an optional
// bearer token (required whenever the server binds a non-loopback address).
import { createHash, timingSafeEqual } from "node:crypto";
import cors from "cors";
import type { NextFunction, Request, RequestHandler, Response } from "express";

export const TOKEN_COOKIE = "kanban_token";
export const MIN_TOKEN_LENGTH = 16;

const DEV_UI_PORT = 5173;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const UNAUTHENTICATED_PATHS = new Set(["/api/health", "/health", "/healthz"]);

export interface SecurityOptions {
  host: string;
  port: number;
  token: string;
  extraAllowedOrigins: string;
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

export function isLoopbackHost(host: string): boolean {
  const h = normalizeHostname(host);
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Returns a startup error message when the bind address / token combination is unsafe. */
export function checkBindSafety(host: string, token: string): string | null {
  if (token && token.length < MIN_TOKEN_LENGTH) {
    return `KANBAN_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters (e.g. \`openssl rand -hex 32\`).`;
  }
  if (!isLoopbackHost(host) && !token) {
    return (
      `Refusing to listen on non-loopback HOST=${host} without KANBAN_TOKEN. ` +
      "Set KANBAN_TOKEN (e.g. `openssl rand -hex 32`) to expose the board on LAN/Tailscale, " +
      "or set HOST=127.0.0.1."
    );
  }
  return null;
}

export function buildAllowedOrigins(port: number, extra: string): Set<string> {
  const origins = new Set<string>();
  for (const hostname of ["127.0.0.1", "localhost", "[::1]"]) {
    for (const p of [port, DEV_UI_PORT]) origins.add(`http://${hostname}:${p}`);
  }
  for (const raw of extra.split(",")) {
    const origin = raw.trim().replace(/\/+$/, "");
    if (origin) origins.add(origin);
  }
  return origins;
}

function tokensMatch(candidate: string, expected: string): boolean {
  const a = createHash("sha256").update(candidate, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function presentedToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  return readCookie(req, TOKEN_COOKIE);
}

function requestHostname(req: Request): string | null {
  const hostHeader = req.headers.host;
  if (!hostHeader) return null;
  try {
    return normalizeHostname(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return null;
  }
}

function isSameOrigin(req: Request, origin: string): boolean {
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * Middleware stack, in order:
 * 1. Host check (loopback binds only): rejects requests whose Host header isn't a loopback name,
 *    so a DNS-rebinding page can't reach the API through the victim's browser.
 * 2. CORS: `Access-Control-Allow-Origin` only for the board's own origins + KANBAN_ALLOWED_ORIGINS.
 * 3. Cross-origin write block: non-GET requests carrying a foreign Origin get 403. CORS alone
 *    doesn't stop "simple" cross-site POSTs from reaching the server.
 * 4. Token (when KANBAN_TOKEN is set): `Authorization: Bearer <token>` or the `kanban_token`
 *    cookie on every /api/* call except health. Visiting any page with `?token=<token>` sets the
 *    cookie (HttpOnly, SameSite=Lax) and redirects to the same URL without the token, so the
 *    browser UI works without code changes.
 */
export function createSecurityMiddleware(options: SecurityOptions): RequestHandler[] {
  const allowedOrigins = buildAllowedOrigins(options.port, options.extraAllowedOrigins);
  const loopbackBind = isLoopbackHost(options.host);
  const { token } = options;

  const hostCheck: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    if (!loopbackBind) return next();
    const hostname = requestHostname(req);
    if (hostname && isLoopbackHost(hostname)) return next();
    res.status(403).json({ error: "host_not_allowed" });
  };

  const corsHandler = cors({
    origin: (origin, callback) => callback(null, Boolean(origin && allowedOrigins.has(origin))),
    credentials: true,
  });

  const crossOriginWriteBlock: RequestHandler = (req, res, next) => {
    const origin = req.headers.origin;
    if (SAFE_METHODS.has(req.method) || !origin) return next();
    if (allowedOrigins.has(origin) || isSameOrigin(req, origin)) return next();
    res.status(403).json({ error: "origin_not_allowed" });
  };

  const tokenAuth: RequestHandler = (req, res, next) => {
    if (!token) return next();

    const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
    if (queryToken !== undefined && req.method === "GET" && !req.path.startsWith("/api/")) {
      if (!tokensMatch(queryToken, token)) {
        res.status(401).type("text/plain").send("Invalid token");
        return;
      }
      res.cookie(TOKEN_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/" });
      const url = new URL(req.originalUrl, "http://placeholder");
      url.searchParams.delete("token");
      res.redirect(302, `${url.pathname}${url.search}`);
      return;
    }

    if (!req.path.startsWith("/api/") || UNAUTHENTICATED_PATHS.has(req.path)) return next();
    const candidate = presentedToken(req);
    if (candidate && tokensMatch(candidate, token)) return next();
    res.status(401).json({ error: "unauthorized" });
  };

  return [hostCheck, corsHandler, crossOriginWriteBlock, tokenAuth];
}
