// Habenula Console — a local web GUI for the Habenula engine.
//
// The browser never talks to the engine. This process does, for two reasons:
// the engine's loopback guard rejects a non-loopback Origin (a browser page
// sends one; Node's fetch sends none), and engine discovery plus `up`/`down`
// are process work, not API calls.
//
// One poller serves every connected tab. Tabs receive state over SSE, so ten
// open tabs cost the engine exactly what one costs.
//
// The engine is unauthenticated on loopback, so this server is too. It binds
// 127.0.0.1 and refuses to bind anything else. Never put it on a network.
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, extname, normalize } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(HERE, "public");

const HOST = "127.0.0.1";
const PORT = Number(process.env.CONSOLE_PORT ?? 7676);
const USER_ID = process.env.HABENULA_USER_ID ?? "cli-user";
// The engine's own default is `demo-user` while the CLI's is `cli-user`. A
// mismatch is not an error — it is a different Durable Object, so the queue
// reads as permanently empty. Surfaced in the UI header for exactly that reason.
const CONFIG_PATH = join(homedir(), ".habenula", "config");
const SCAN_PORTS = Array.from({ length: 10 }, (_, i) => 8787 + i);

const POLL_IDLE_MS = 4000;
const POLL_ACTIVE_MS = 1000; // while a decision is parked, or a tab is focused
const DISCOVER_BACKOFF_MS = 5000;

// ─── engine discovery ───────────────────────────────────────────────────────

/** The port the CLI would have written, if any. */
function configuredPort() {
  try {
    const m = /^HABENULA_PORT=(\d+)/m.exec(readFileSync(CONFIG_PATH, "utf8"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function answersHealth(port, signal) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.engine === "habenula-engine";
  } catch {
    return false;
  }
}

/**
 * Walk the same path the CLI does: the configured port first, then the scan
 * range. Returns the tried list either way so an unreachable engine can say
 * what it looked for rather than rendering an empty queue.
 */
async function discoverEngine() {
  if (process.env.HABENULA_URL) {
    const url = process.env.HABENULA_URL.replace(/\/$/, "");
    const port = Number(new URL(url).port || 80);
    const ok = await answersHealth(port, AbortSignal.timeout(1500));
    return { url: ok ? url : null, tried: [{ port, ok }], pinned: true };
  }
  const order = [...new Set([configuredPort(), ...SCAN_PORTS].filter(Boolean))];
  const tried = [];
  for (const port of order) {
    const ok = await answersHealth(port, AbortSignal.timeout(700));
    tried.push({ port, ok });
    if (ok) return { url: `http://127.0.0.1:${port}`, tried, pinned: false };
  }
  return { url: null, tried, pinned: false };
}

// ─── engine state, shared by every tab ──────────────────────────────────────

const state = {
  engineUrl: null,
  tried: [],
  reachable: false,
  userId: USER_ID,
  status: null, // StatusResponse
  settings: null,
  policy: null,
  services: null,
  catalog: null,
  tasks: null,
  error: null,
  lastOk: null,
};

let stateHash = "";
const clients = new Set();
let focusedTabs = 0;
let pollTimer = null;

function hashOf(obj) {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

/** Public view of engine state — what a tab renders from. */
function snapshot() {
  return {
    engineUrl: state.engineUrl,
    reachable: state.reachable,
    tried: state.tried,
    userId: state.userId,
    status: state.status,
    settings: state.settings,
    policy: state.policy,
    services: state.services,
    catalog: state.catalog,
    tasks: state.tasks,
    error: state.error,
    lastOk: state.lastOk,
  };
}

async function engineGet(path, signal) {
  const res = await fetch(`${state.engineUrl}${path}`, { signal });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text.slice(0, 500) };
  }
  if (!res.ok) {
    const err = new Error(body?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.code = body?.error_code;
    throw err;
  }
  return body;
}

const u = encodeURIComponent;

/**
 * One tick. Status every time — it carries the parked calls, so it is the one
 * read that must be fresh. The slower-moving reads (catalog, policy, services,
 * settings, tasks) refresh on a longer stride, since a tick that re-fetches
 * everything would multiply engine load by six for no new information.
 */
let tick = 0;
async function poll() {
  pollTimer = null;
  const signal = AbortSignal.timeout(8000);
  try {
    if (!state.engineUrl) {
      const found = await discoverEngine();
      state.engineUrl = found.url;
      state.tried = found.tried;
      if (!found.url) {
        setReachable(false, "No engine answered /api/health.");
        return schedule(DISCOVER_BACKOFF_MS);
      }
    }

    const status = await engineGet(`/api/status?userId=${u(USER_ID)}`, signal);
    state.status = status;

    const slow = tick % 5 === 0;
    if (slow) {
      const [settings, policy, services, catalog, tasks] = await Promise.all([
        engineGet(`/api/settings?userId=${u(USER_ID)}`, signal).catch(() => state.settings),
        engineGet(`/api/policy?userId=${u(USER_ID)}`, signal).catch(() => state.policy),
        engineGet(`/api/services?userId=${u(USER_ID)}`, signal).catch(() => state.services),
        engineGet(`/api/services/catalog`, signal).catch(() => state.catalog),
        engineGet(`/api/tasks?userId=${u(USER_ID)}&limit=25`, signal).catch(() => state.tasks),
      ]);
      Object.assign(state, { settings, policy, services, catalog, tasks });
    }
    tick += 1;
    setReachable(true, null);
  } catch (err) {
    // A read that fails after the engine was found means it went away or is
    // wedged. Drop the URL so the next tick rediscovers rather than hammering
    // a dead port.
    state.engineUrl = null;
    setReachable(false, err.message ?? String(err));
  } finally {
    const held = state.status?.held?.length ?? 0;
    const fast = held > 0 || focusedTabs > 0;
    schedule(state.reachable ? (fast ? POLL_ACTIVE_MS : POLL_IDLE_MS) : DISCOVER_BACKOFF_MS);
  }
}

function setReachable(ok, error) {
  state.reachable = ok;
  state.error = ok ? null : error;
  if (ok) state.lastOk = new Date().toISOString();
  // Push only on change. A parked decision that nobody answered for a minute
  // should not repaint sixty times.
  const next = hashOf(snapshot());
  if (next !== stateHash) {
    stateHash = next;
    broadcast("state", snapshot());
  }
}

function schedule(ms) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, ms);
}

// ─── actions ────────────────────────────────────────────────────────────────

async function enginePost(path, body) {
  const res = await fetch(`${state.engineUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: text.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

/** `habenula up` / `down`. Process lifecycle, not an API call. */
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn("habenula", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    // spawn reports a missing binary asynchronously via 'error'; a try/catch
    // around spawn never sees it. (This is the upstream connect.ts bug.)
    child.on("error", (err) => resolve({ code: -1, out: `${out}\n${err.message}` }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const ACTIONS = {
  async resolve({ heldCallId, choice }) {
    return enginePost("/api/resolve", { userId: USER_ID, heldCallId, choice });
  },
  async kill() {
    return enginePost("/api/kill", { userId: USER_ID });
  },
  async quit() {
    return enginePost("/api/session/quit", { userId: USER_ID });
  },
  async disconnect({ service }) {
    return enginePost("/api/services/disconnect", { userId: USER_ID, service });
  },
  async connect({ service }) {
    return enginePost(`/connect/${u(service)}?userId=${u(USER_ID)}`, {});
  },
  async connectStatus({ service, flow }) {
    try {
      const body = await engineGet(
        `/api/connect/status?userId=${u(USER_ID)}&service=${u(service)}&flow=${u(flow)}`,
        AbortSignal.timeout(8000),
      );
      return { ok: true, status: 200, body };
    } catch (err) {
      return { ok: false, status: err.status ?? 0, body: { error: err.message } };
    }
  },
  async connectCancel({ flow }) {
    return enginePost("/api/connect/cancel", { userId: USER_ID, flow });
  },
  async caps({ monthLimitCents, sessionLimitCents }) {
    const body = { userId: USER_ID };
    if (Number.isInteger(monthLimitCents)) body.monthLimitCents = monthLimitCents;
    if (Number.isInteger(sessionLimitCents)) body.sessionLimitCents = sessionLimitCents;
    return enginePost("/api/settings", body);
  },
  async cancelTask({ taskId }) {
    return enginePost("/api/tasks/cancel", { userId: USER_ID, taskId });
  },
  async audit({ cursor, limit }) {
    const q = new URLSearchParams({ userId: USER_ID, limit: String(limit ?? 50) });
    if (cursor) q.set("cursor", cursor);
    try {
      const body = await engineGet(`/api/audit?${q}`, AbortSignal.timeout(15000));
      return { ok: true, status: 200, body };
    } catch (err) {
      return { ok: false, status: err.status ?? 0, body: { error: err.message } };
    }
  },
  async taskDetail({ taskId }) {
    try {
      const body = await engineGet(
        `/api/tasks/get?userId=${u(USER_ID)}&taskId=${u(taskId)}`,
        AbortSignal.timeout(8000),
      );
      return { ok: true, status: 200, body };
    } catch (err) {
      return { ok: false, status: err.status ?? 0, body: { error: err.message } };
    }
  },
  async engineUp() {
    const r = await runCli(["up"]);
    state.engineUrl = null; // force rediscovery on the next tick
    schedule(200);
    return { ok: r.code === 0, status: r.code === 0 ? 200 : 500, body: { output: r.out } };
  },
  async engineDown() {
    const r = await runCli(["down"]);
    state.engineUrl = null;
    schedule(200);
    return { ok: r.code === 0, status: r.code === 0 ? 200 : 500, body: { output: r.out } };
  },
};

// ─── http ───────────────────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (url.pathname === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    // A proxy or a sleeping laptop can silently drop an idle stream; a comment
    // frame every 20s keeps it observably alive.
    const ka = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {
        /* cleaned up on close */
      }
    }, 20000);
    req.on("close", () => {
      clearInterval(ka);
      clients.delete(res);
    });
    return;
  }

  if (url.pathname === "/api/focus" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    focusedTabs = Math.max(0, focusedTabs + (body.focused ? 1 : -1));
    res.writeHead(204).end();
    return;
  }

  if (url.pathname.startsWith("/api/do/") && req.method === "POST") {
    const name = url.pathname.slice("/api/do/".length);
    const action = ACTIONS[name];
    if (!action) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: `unknown action ${name}` }));
    }
    if (!state.engineUrl && !name.startsWith("engine")) {
      res.writeHead(503, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "engine unreachable" }));
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "malformed JSON body" }));
    }
    try {
      const out = await action(body);
      // Any mutation can change what the queue holds; refresh promptly rather
      // than leaving the tab to wait out the poll interval.
      schedule(150);
      res.writeHead(out.status || (out.ok ? 200 : 500), {
        "content-type": "application/json",
      });
      return res.end(JSON.stringify(out.body ?? {}));
    } catch (err) {
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: err.message ?? String(err) }));
    }
  }

  // static
  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC, safe);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const buf = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(buf);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Habenula Console  →  http://${HOST}:${PORT}`);
  console.log(`  userId: ${USER_ID}`);
  console.log(`  engine: discovering (config port, then 8787–8796)…`);
  console.log(`  This server is unauthenticated, like the engine. Keep it on loopback.`);
  poll();
});
