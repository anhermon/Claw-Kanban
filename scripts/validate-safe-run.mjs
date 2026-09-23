#!/usr/bin/env node
// Safe end-to-end validation of the Claw-Kanban server + built UI against a COPY of a real board.
//
// Safety model (every server started here):
// - DB is an sqlite `.backup` copy; logs and the agent-harness state dir are copies in a temp dir
// - KANBAN_DISABLE_DISPATCH=1, plus PATH-first stubs for claude/codex/gemini/agy/opencode/openclaw
//   that only record their argv
// - bound to 127.0.0.1 on a random free port (never 8787), env built from scratch (no .env)
// The one non-loopback case (HOST=0.0.0.0 without a token) must refuse to start, and is asserted
// to leave nothing listening and no DB file behind.
//
// Usage: pnpm build && node scripts/validate-safe-run.mjs
// Env:   KANBAN_SRC_DB (default ../Claw-Kanban/kanban.sqlite), HARNESS_SRC_DIR
//        (default ~/.claude/agent-harness), PLAYWRIGHT_FROM (dir whose node_modules has playwright),
//        VALIDATE_WORKDIR (default: fresh temp dir)

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DB = process.env.KANBAN_SRC_DB ?? path.resolve(ROOT, "..", "Claw-Kanban", "kanban.sqlite");
const HARNESS_SRC = process.env.HARNESS_SRC_DIR ?? path.join(os.homedir(), ".claude", "agent-harness");
const PLAYWRIGHT_FROM = process.env.PLAYWRIGHT_FROM ?? path.join(os.homedir(), "workspace", "prod", "automation");
const FORBIDDEN_PORT = 8787;
const AGENT_STUBS = ["claude", "codex", "gemini", "agy", "opencode", "openclaw"];
// Argv fragments that only appear when the board launches an agent run (vs. --version/which probes).
const AGENT_RUN_MARKERS = ["--dangerously-skip-permissions", "--yolo", "--print", "exec --json", "run --format"];

let failures = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function assertOrThrow(cond, message) {
  if (!cond) throw new Error(message);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollUntil(fn, { timeoutMs = 20_000, intervalMs = 150, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      /* not ready */
    }
    await wait(intervalMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => (port === FORBIDDEN_PORT ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}

function listeningPids(port) {
  try {
    return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return []; // lsof exits 1 when nothing matches
  }
}

// fetch() may normalise Host/Cookie headers, so header-sensitive checks use raw requests.
function rawRequestStatus(port, urlPath, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end(body);
  });
}

function rawGetStatus(port, urlPath, headers) {
  return rawRequestStatus(port, urlPath, { headers });
}

function sqliteScalar(dbPath, sql) {
  return execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" }).trim();
}

function prepareWorkdir() {
  assertOrThrow(!fs.existsSync(path.join(ROOT, ".env")), `${ROOT}/.env exists; refusing (it would leak into the run)`);
  assertOrThrow(fs.existsSync(path.join(ROOT, "dist", "index.html")), "dist/ missing: run `pnpm build` first");
  assertOrThrow(fs.existsSync(SRC_DB), `source DB not found: ${SRC_DB}`);

  const work = process.env.VALIDATE_WORKDIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "kanban-validate-"));
  fs.mkdirSync(work, { recursive: true });
  const db = path.join(work, "kanban.sqlite");
  fs.rmSync(db, { force: true });
  execFileSync("sqlite3", [SRC_DB, `.backup '${db}'`]);

  const harness = path.join(work, "agent-harness");
  fs.rmSync(harness, { recursive: true, force: true });
  if (fs.existsSync(HARNESS_SRC)) fs.cpSync(HARNESS_SRC, harness, { recursive: true });
  else fs.mkdirSync(harness, { recursive: true });

  const bin = path.join(work, "stub-bin");
  const stubLog = path.join(work, "stub-invocations.log");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(stubLog, "");
  for (const name of AGENT_STUBS) {
    const stub = path.join(bin, name);
    fs.writeFileSync(stub, `#!/bin/sh\necho "${name} $*" >> '${stubLog}'\nexit 0\n`);
    fs.chmodSync(stub, 0o755);
  }
  const logs = path.join(work, "logs");
  fs.mkdirSync(logs, { recursive: true });
  return { work, db, harness, bin, stubLog, logs };
}

function startServer(ctx, { port, host = "127.0.0.1", token, dbPath = ctx.db, dispatchDisabled = true }) {
  const env = {
    PATH: `${ctx.bin}:${process.env.PATH}`,
    HOME: os.homedir(),
    PORT: String(port),
    HOST: host,
    DB_PATH: dbPath,
    LOGS_DIR: ctx.logs,
    HARNESS_DATA_DIR: ctx.harness,
    ...(dispatchDisabled ? { KANBAN_DISABLE_DISPATCH: "1" } : {}),
    ...(token ? { KANBAN_TOKEN: token } : {}),
  };
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsxCli, "server/index.ts"], {
    cwd: ROOT,
    env,
    detached: true, // own process group so stop() also kills tsx's child
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [];
  child.stdout.on("data", (d) => out.push(d.toString()));
  child.stderr.on("data", (d) => out.push(d.toString()));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, port, output: () => out.join(""), exited };
}

async function stopServer(server) {
  if (server.child.exitCode === null) {
    try {
      process.kill(-server.child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    const timedOut = await Promise.race([server.exited.then(() => false), wait(5_000).then(() => true)]);
    if (timedOut) {
      try {
        process.kill(-server.child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      await server.exited;
    }
  }
  await pollUntil(() => listeningPids(server.port).length === 0, { timeoutMs: 5_000, what: `port ${server.port} released` });
}

async function waitHealthy(server) {
  await pollUntil(
    async () => {
      if (server.child.exitCode !== null) throw new Error(`server exited early:\n${server.output()}`);
      const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
      return res.status === 200;
    },
    { what: "server health" },
  ).catch((e) => {
    if (server.child.exitCode !== null) throw new Error(`server exited early:\n${server.output()}`);
    throw e;
  });
}

function loadPlaywright() {
  const req = createRequire(path.join(PLAYWRIGHT_FROM, "package.json"));
  return req("playwright");
}

async function checkUi(browser, url, { expectCardTitle, label }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const inboxHeader = page.locator(".colHeader span", { hasText: /^Inbox$/ });
    await inboxHeader.first().waitFor({ state: "visible", timeout: 15_000 });
    check(`[${label}] UI renders Inbox column header`, true);
    if (expectCardTitle) {
      const card = page.locator(".cardTitle", { hasText: expectCardTitle });
      const visible = await card
        .first()
        .waitFor({ state: "attached", timeout: 15_000 })
        .then(() => true, () => false);
      check(`[${label}] UI shows card loaded from API`, visible, expectCardTitle);
    }
    // Let the initial polling round finish so late fetch errors surface.
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    check(`[${label}] zero console errors`, consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
    return { finalUrl: page.url() };
  } finally {
    await context.close();
  }
}

async function main() {
  const ctx = prepareWorkdir();
  console.log(`workdir: ${ctx.work}`);
  const runsBefore = Number(sqliteScalar(ctx.db, "SELECT count(*) FROM card_runs"));
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const started = [];

  try {
    // ---- 1. Loopback, no token ------------------------------------------------------------
    const port1 = await freePort();
    const s1 = startServer(ctx, { port: port1 });
    started.push(s1);
    await waitHealthy(s1);
    const base1 = `http://127.0.0.1:${port1}`;

    const health = await fetch(`${base1}/api/health`);
    check("GET /api/health -> 200", health.status === 200, `got ${health.status}`);

    const harnessStatus = await (await fetch(`${base1}/api/harness/status`)).json();
    check("harness-sync uses the copied state dir", harnessStatus.harnessDir === ctx.harness, harnessStatus.harnessDir);

    const pre = await fetch(`${base1}/api/cards`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    check("OPTIONS from https://evil.example -> no ACAO", pre.headers.get("access-control-allow-origin") === null,
      `ACAO=${pre.headers.get("access-control-allow-origin")}`);

    const good = await fetch(`${base1}/api/cards`, {
      method: "OPTIONS",
      headers: { Origin: base1, "Access-Control-Request-Method": "POST" },
    });
    check("OPTIONS from board origin -> ACAO echoes it", good.headers.get("access-control-allow-origin") === base1,
      `ACAO=${good.headers.get("access-control-allow-origin")}`);

    const evilPost = await fetch(`${base1}/api/cards`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ title: "should-not-exist" }),
    });
    check("cross-origin POST from evil origin -> 403", evilPost.status === 403, `got ${evilPost.status}`);

    const rebindStatus = await rawGetStatus(port1, "/api/cards", { Host: `evil.example:${port1}` });
    check("DNS-rebinding Host header on loopback bind -> 403", rebindStatus === 403, `got ${rebindStatus}`);

    const title = `validate-safe-run ${Date.now()}`;
    const created = await fetch(`${base1}/api/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, description: "created by validate-safe-run.mjs", project_path: ctx.work, assignee: "claude" }),
    });
    const createdBody = await created.json();
    check("create card -> 200 with id", created.status === 200 && typeof createdBody.id === "string", `got ${created.status}`);
    const cardId = createdBody.id;

    for (const status of ["Planned", "In Progress"]) {
      const moved = await fetch(`${base1}/api/cards/${cardId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      check(`move card -> ${status}`, moved.status === 200, `got ${moved.status}`);
    }

    const run = await fetch(`${base1}/api/cards/${cardId}/run`, { method: "POST" });
    check("POST /run refused while dispatch disabled (409)", run.status === 409, `got ${run.status}`);
    const dispatch = await (await fetch(`${base1}/api/queue/dispatch-next`, { method: "POST" })).json();
    check("queue dispatch-next does not dispatch", dispatch.dispatched === false, dispatch.reason);

    await checkUi(browser, `${base1}/`, { expectCardTitle: title, label: "no token" });

    // Give the 4s queue worker at least two ticks to prove it doesn't launch anything either.
    await wait(9_000);
    const cardRow = sqliteScalar(ctx.db, `SELECT status FROM cards WHERE id = '${cardId}'`);
    check("moved card kept its status (no run side effects)", cardRow === "In Progress", cardRow);
    const runsAfter = Number(sqliteScalar(ctx.db, "SELECT count(*) FROM card_runs"));
    check("card_runs unchanged (no agent run recorded)", runsAfter === runsBefore, `${runsBefore} -> ${runsAfter}`);
    const stubLines = fs.readFileSync(ctx.stubLog, "utf8").split("\n").filter(Boolean);
    const agentRuns = stubLines.filter((l) => AGENT_RUN_MARKERS.some((m) => l.includes(m)));
    check("no agent CLI launched (stub log)", agentRuns.length === 0,
      `${stubLines.length} probe call(s), ${agentRuns.length} run call(s)`);

    await stopServer(s1);
    check("server 1 stopped, port released", listeningPids(port1).length === 0);

    // ---- 2. Non-loopback without token must refuse to start -------------------------------
    const port2 = await freePort();
    const refusedDb = path.join(ctx.work, "refused.sqlite");
    fs.rmSync(refusedDb, { force: true });
    const s2 = startServer(ctx, { port: port2, host: "0.0.0.0", dbPath: refusedDb });
    started.push(s2);
    const code = await Promise.race([s2.exited, wait(15_000).then(() => "timeout")]);
    check("HOST=0.0.0.0 without KANBAN_TOKEN exits non-zero", typeof code === "number" && code !== 0, `exit=${code}`);
    check("refusal message explains KANBAN_TOKEN", /Refusing to listen .*KANBAN_TOKEN/.test(s2.output()));
    check("refused start left nothing listening", listeningPids(port2).length === 0);
    check("refused start did not create a DB", !fs.existsSync(refusedDb));
    await stopServer(s2);

    const s2b = startServer(ctx, { port: port2, host: "127.0.0.1", token: "short", dbPath: refusedDb });
    started.push(s2b);
    const codeShort = await Promise.race([s2b.exited, wait(15_000).then(() => "timeout")]);
    check("KANBAN_TOKEN shorter than 16 chars exits non-zero", typeof codeShort === "number" && codeShort !== 0, `exit=${codeShort}`);
    await stopServer(s2b);

    // ---- 3. Token mode (loopback bind; enforcement is the same code path as non-loopback) ---
    const token = randomBytes(24).toString("hex");
    const port3 = await freePort();
    const s3 = startServer(ctx, { port: port3, token });
    started.push(s3);
    await waitHealthy(s3);
    const base3 = `http://127.0.0.1:${port3}`;
    const auth = { Authorization: `Bearer ${token}` };

    const h3 = await fetch(`${base3}/api/health`);
    check("[token] /api/health reachable without token", h3.status === 200, `got ${h3.status}`);
    const listNoTok = await fetch(`${base3}/api/cards`);
    check("[token] GET /api/cards without token -> 401", listNoTok.status === 401, `got ${listNoTok.status}`);
    const title3 = `validate-safe-run token ${Date.now()}`;
    const body3 = JSON.stringify({ title: title3, description: "token mode", project_path: ctx.work });
    const postNoTok = await fetch(`${base3}/api/cards`, { method: "POST", headers: { "content-type": "application/json" }, body: body3 });
    check("[token] tokenless POST -> 401", postNoTok.status === 401, `got ${postNoTok.status}`);
    const postBadTok = await fetch(`${base3}/api/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer wrong-token-wrong-token" },
      body: body3,
    });
    check("[token] wrong-token POST -> 401", postBadTok.status === 401, `got ${postBadTok.status}`);
    const postTok = await fetch(`${base3}/api/cards`, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: body3 });
    check("[token] POST with bearer token -> 200", postTok.status === 200, `got ${postTok.status}`);

    // LAN-style browser writes: the dashboard's own origin is NOT in the allowlist (think
    // http://100.x.y.z:PORT), so writes pass only via the same-origin rule + cookie. 127.0.0.2 is
    // loopback (passes the Host check) but not allowlisted, so it exercises exactly that path.
    const lanHost = `127.0.0.2:${port3}`;
    const lanWrite = (headers) =>
      rawRequestStatus(port3, "/api/cards", {
        method: "POST",
        headers: { Host: lanHost, "content-type": "application/json", ...headers },
        body: JSON.stringify({ title: `validate-safe-run lan ${Date.now()}-${Math.random()}`, project_path: ctx.work }),
      });
    const lanOk = await lanWrite({ Origin: `http://${lanHost}`, Cookie: `kanban_token=${token}` });
    check("[token] same-origin (non-allowlisted) write with cookie -> 200", lanOk === 200, `got ${lanOk}`);
    const lanNoCookie = await lanWrite({ Origin: `http://${lanHost}` });
    check("[token] same-origin write without cookie -> 401 (auth, not origin)", lanNoCookie === 401, `got ${lanNoCookie}`);
    const lanForeign = await lanWrite({ Origin: `http://127.0.0.3:${port3}`, Cookie: `kanban_token=${token}` });
    check("[token] foreign-origin write even with cookie -> 403", lanForeign === 403, `got ${lanForeign}`);

    const ui3 = await checkUi(browser, `${base3}/?token=${token}`, { expectCardTitle: title3, label: "token via ?token= cookie" });
    check("[token] ?token= is stripped from the URL after cookie bootstrap", !ui3.finalUrl.includes("token="), ui3.finalUrl.replace(token, "<token>"));

    await stopServer(s3);
    check("server 3 stopped, port released", listeningPids(port3).length === 0);

    // ---- 4. Control: prove the "no agent launched" detection isn't vacuous -----------------
    // Dispatch ENABLED, but only after asserting every agent name resolves to its no-op stub.
    const stubPath = `${ctx.bin}:${process.env.PATH}`;
    const shadowed = AGENT_STUBS.every(
      (name) => execFileSync("sh", ["-c", `command -v ${name}`], { env: { PATH: stubPath }, encoding: "utf8" }).trim() ===
        path.join(ctx.bin, name),
    );
    assertOrThrow(shadowed, "agent stubs do not shadow real CLIs; refusing to run the dispatch-enabled control");
    const port4 = await freePort();
    const s4 = startServer(ctx, { port: port4, dispatchDisabled: false });
    started.push(s4);
    await waitHealthy(s4);
    const base4 = `http://127.0.0.1:${port4}`;
    const ctl = await (await fetch(`${base4}/api/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: `validate-safe-run control ${Date.now()}`, project_path: ctx.work, assignee: "claude" }),
    })).json();
    const ctlRun = await fetch(`${base4}/api/cards/${ctl.id}/run`, { method: "POST" });
    check("[control] dispatch enabled: /run accepted", ctlRun.status === 200, `got ${ctlRun.status}`);
    const recorded = await pollUntil(
      () => fs.readFileSync(ctx.stubLog, "utf8").split("\n").some((l) => l.startsWith("claude ") && l.includes("--dangerously-skip-permissions")),
      { timeoutMs: 10_000, what: "stub to record the claude run" },
    ).catch(() => false);
    check("[control] the run hit the claude stub (detector works)", recorded === true);
    await stopServer(s4);
    check("server 4 stopped, port released", listeningPids(port4).length === 0);
  } finally {
    await browser.close();
    for (const s of started) await stopServer(s).catch(() => {});
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`ERROR: ${err.stack ?? err}`);
  process.exit(1);
});
