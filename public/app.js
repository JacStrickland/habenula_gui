"use strict";
// Habenula Console — client. Renders engine state and answers held calls.
// It holds no credentials and makes no policy decision; every decision is the
// engine's. This is a view and a set of buttons.

// ── untrusted text ──────────────────────────────────────────────────────────
// Every string in a held call was chosen by an agent: the recipient of an
// email, a goal, a parameter value. It is escaped, clamped, and anything that
// could misrepresent the permission is FLAGGED rather than silently stripped —
// a hidden character removed without comment is a changed meaning you can't see.

const MAX_LEN = 2000;

/** Control chars (minus tab/newline) and the Unicode format characters that
 *  can fake a line break, reverse reading order, or hide content entirely. */
const SUSPECT = [
  [/[\u0000-\u0008\u000B-\u001F\u007F]/g, "control character"],
  [/[\u200B-\u200F\u2060\uFEFF]/g, "zero-width character"],
  [/[\u202A-\u202E\u2066-\u2069]/g, "bidi override"],
  [/[\u2028\u2029]/g, "line separator"],
];

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render an agent-supplied string as safe HTML. Returns the escaped text plus
 * flag badges naming what was found. Suspect characters are replaced with a
 * visible glyph so the string's real length and shape stay honest.
 */
function untrusted(raw) {
  let s = raw == null ? "" : String(raw);
  const found = new Set();
  let clamped = false;
  if (s.length > MAX_LEN) {
    s = s.slice(0, MAX_LEN);
    clamped = true;
  }
  for (const [re, label] of SUSPECT) {
    if (re.test(s)) {
      found.add(label);
      s = s.replace(re, "␣"); // ␣ — a visible stand-in, not a silent removal
    }
  }
  let html = escapeHtml(s);
  if (clamped) found.add("clamped at " + MAX_LEN + " chars");
  for (const f of found) {
    html += ' <span class="flag" title="flagged by the console">' + escapeHtml(f) + "</span>";
  }
  return html;
}

// ── small helpers ───────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const money = (cents) => "$" + (cents / 100).toFixed(2);

function relTime(iso) {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins + "m ago";
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.round(hrs / 24) + "d ago";
}

function minutesLeft(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.round(ms / 60000));
}

function toast(msg, kind) {
  const el = document.createElement("div");
  el.className = "toast " + (kind || "");
  el.innerHTML = msg;
  $("toasts").append(el);
  setTimeout(() => el.remove(), kind === "err" ? 8000 : 4500);
}

// ── transport ───────────────────────────────────────────────────────────────
// The UI is transport-agnostic. Locally it talks to server.mjs, which proxies a
// real engine over SSE. On the hosted demo it talks to an in-page fixture that
// implements the same action surface. Identical render code either way — the
// demo is the same console, not a screenshot of it.
const DEMO = typeof window !== "undefined" && Boolean(window.HABENULA_DEMO);

async function act(name, body) {
  if (DEMO) return window.HABENULA_DEMO.act(name, body || {});
  const res = await fetch("/api/do/" + name, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  let parsed = {};
  try {
    parsed = await res.json();
  } catch {
    /* an empty body is fine */
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

// ── state ───────────────────────────────────────────────────────────────────
let S = null;
let selected = 0;
let servicesTab = "connected";
let auditEntries = [];
let auditCursor = null;
let auditLoading = false;

// ── the permission line ─────────────────────────────────────────────────────
// service · verb · "noun" — a service, a verb, and the exact thing acted on.
function permHtml(h) {
  return (
    '<span class="svc">' + untrusted(h.service) + "</span>" +
    '<span class="sep">·</span>' +
    '<span class="verb">' + untrusted(h.verb) + "</span>" +
    '<span class="sep">·</span>' +
    '<span class="noun">' + untrusted(h.noun) + "</span>"
  );
}

function paramsHtml(params) {
  const keys = Object.keys(params || {});
  if (!keys.length) return "";
  const rows = keys
    .map((k) => {
      const v = params[k];
      const text = typeof v === "string" ? v : JSON.stringify(v);
      return "<dt>" + untrusted(k) + "</dt><dd>" + untrusted(text) + "</dd>";
    })
    .join("");
  return (
    '<details class="params"><summary>requested with ' + keys.length +
    " parameter" + (keys.length === 1 ? "" : "s") +
    "</summary><dl>" + rows + "</dl></details>"
  );
}

function spendHtml(spend) {
  if (!spend) return "";
  const reasons = {
    over_limit: "This would exceed a cap you set.",
    unpriced: "The engine could not price this call.",
    totals_unavailable: "Spend totals could not be read, so the cap cannot be checked.",
  };
  const reason = reasons[spend.reason] || spend.reason;
  const amt = spend.amountCents == null ? "amount unknown" : money(spend.amountCents);
  const rows = (spend.breaches || [])
    .map(
      (b) =>
        "<tr><td>" + escapeHtml(b.window) + " cap</td><td>" +
        money(b.spentCents) + " of " + money(b.limitCents) + "</td></tr>",
    )
    .join("");
  return (
    '<div class="spend-box"><div class="amt">' + escapeHtml(amt) + "</div>" +
    (spend.summary ? '<div style="margin-top:2px">' + untrusted(spend.summary) + "</div>" : "") +
    '<div style="margin-top:4px;color:var(--ink-2)">' + escapeHtml(reason) + "</div>" +
    (rows ? "<table>" + rows + "</table>" : "") +
    "</div>"
  );
}

function renderHeld() {
  const held = (S && S.status && S.status.held) || [];
  $("held-count").textContent = String(held.length);
  const list = $("held-list");

  if (!held.length) {
    list.innerHTML =
      '<div class="empty">Nothing is waiting. When an agent proposes a consequential action, it parks here.</div>';
    return;
  }
  if (selected >= held.length) selected = held.length - 1;
  if (selected < 0) selected = 0;

  list.innerHTML = held
    .map((h, i) => {
      const isSpend = Boolean(h.spend);
      const badges =
        (h.origin === "mcp_commission"
          ? '<span class="badge mcp">↑ asked for by your coding agent</span> '
          : "") + (isSpend ? '<span class="badge spend">spend hold</span>' : "");
      // A spend hold takes approve_once and refuses the grant-minting choices;
      // an ordinary hold is the reverse. The engine enforces this, so the UI
      // must not offer a button the engine will reject.
      const id = escapeHtml(h.heldCallId);
      const affirmatives = isSpend
        ? '<button class="btn primary" data-choice="approve_once" data-id="' + id + '">Approve once</button>'
        : '<button class="btn" data-choice="task" data-id="' + id + '">Allow for this task <kbd>3</kbd></button>' +
          '<button class="btn primary" data-choice="session" data-id="' + id + '">Allow for this session <kbd>4</kbd></button>';
      return (
        '<div class="hold ' + (i === selected ? "sel" : "") + '" data-idx="' + i + '">' +
        '<div class="perm">' + permHtml(h) + "</div>" +
        '<div style="margin-top:6px">' + badges + "</div>" +
        (h.goal
          ? '<div class="goal"><b style="color:var(--ink-3);font-weight:600">goal </b>' + untrusted(h.goal) + "</div>"
          : "") +
        spendHtml(h.spend) +
        paramsHtml(h.params) +
        '<div class="acts">' +
        '<button class="btn danger" data-choice="deny" data-id="' + id + '">Deny <kbd>1</kbd></button>' +
        '<button class="btn" data-choice="tell_more" data-id="' + id + '">What is this? <kbd>2</kbd></button>' +
        '<span class="spacer"></span>' + affirmatives +
        "</div></div>"
      );
    })
    .join("");
}

function renderGrants() {
  const grants = (S && S.status && S.status.grants) || [];
  $("grants-count").textContent = String(grants.length);
  const el = $("grants-list");
  if (!grants.length) {
    el.innerHTML =
      '<div class="empty">No grants in force. With none, the agent can do nothing.<br>' +
      '<span style="font-size:12px">A task grant is consumed the moment its call runs — an empty list right after approving is correct.</span></div>';
    return;
  }
  el.innerHTML =
    '<div class="rows">' +
    grants
      .map((g) => {
        const left = minutesLeft(g.expiresAt);
        return (
          '<div class="row"><div class="grow">' +
          '<div class="mono trunc">' + untrusted(g.service) + " · " + untrusted(g.verb) + " · " + untrusted(g.noun) + "</div>" +
          '<div class="sub">' + escapeHtml(g.source) + (left == null ? "" : " · " + left + "m left") + "</div>" +
          "</div></div>"
        );
      })
      .join("") +
    "</div>";
}

function renderCaps() {
  const s = S && S.settings;
  const el = $("caps-body");
  if (!s) {
    el.innerHTML = '<div class="empty">—</div>';
    return;
  }
  const bar = (spent, limit) => {
    const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;
    const cls = pct >= 100 ? "over" : pct >= 75 ? "warn" : "";
    return '<div class="meter"><i class="' + cls + '" style="width:' + pct + '%"></i></div>';
  };
  const row = (label, spent, limit, isDefault, field) =>
    '<div style="margin-bottom:14px"><div class="cap-row">' +
    '<span style="color:var(--ink-3);width:58px">' + label + "</span>" +
    '<span class="n">' + money(spent) + "</span>" +
    '<span style="color:var(--ink-3)">of</span>' +
    '<input type="number" min="0" step="1" value="' + (limit / 100).toFixed(2) +
    '" data-cap="' + field + '" aria-label="' + label + ' cap in dollars">' +
    (isDefault ? '<span style="color:var(--ink-3);font-size:12px">default</span>' : "") +
    "</div>" + bar(spent, limit) + "</div>";

  el.innerHTML =
    row("monthly", s.monthSpentCents, s.monthLimitCents, s.monthIsDefault, "monthLimitCents") +
    row("session", s.sessionSpentCents, s.sessionLimitCents, s.sessionIsDefault, "sessionLimitCents") +
    '<button class="btn sm" id="btn-caps">Save caps</button>' +
    '<div style="color:var(--ink-3);font-size:12px;margin-top:8px">Spending counts when an order is placed.</div>';

  $("btn-caps").onclick = async () => {
    const body = {};
    for (const input of el.querySelectorAll("input[data-cap]")) {
      const dollars = Number(input.value);
      if (!Number.isFinite(dollars) || dollars < 0) {
        toast("Caps must be a non-negative number of dollars.", "err");
        return;
      }
      body[input.dataset.cap] = Math.round(dollars * 100);
    }
    const r = await act("caps", body);
    toast(
      r.ok ? "Caps updated." : "Could not update caps: " + escapeHtml(r.body.error || r.status),
      r.ok ? "ok" : "err",
    );
  };
}

function renderServices() {
  const connected = (S && S.services && S.services.services) || [];
  const all = (S && S.catalog && S.catalog.services) || [];
  const connectedNames = new Set(connected.map((s) => s.service));
  const el = $("services-list");
  for (const b of document.querySelectorAll("[data-tab]")) {
    b.setAttribute("aria-selected", String(b.dataset.tab === servicesTab));
  }
  if (servicesTab === "connected") {
    if (!connected.length) {
      el.innerHTML = '<div class="empty">No services connected.</div>';
      return;
    }
    el.innerHTML =
      '<div class="rows">' +
      connected
        .map(
          (s) =>
            '<div class="row"><div class="grow"><div class="mono">' + untrusted(s.service) + "</div>" +
            '<div class="sub">connected ' + relTime(s.connected_at) + "</div></div>" +
            '<button class="btn sm danger" data-disconnect="' + escapeHtml(s.service) + '">Disconnect</button></div>',
        )
        .join("") +
      "</div>";
  } else {
    const available = all.filter((s) => !connectedNames.has(s.service));
    if (!available.length) {
      el.innerHTML = '<div class="empty">Everything in the catalog is connected.</div>';
      return;
    }
    el.innerHTML =
      '<div class="rows">' +
      available
        .map(
          (s) =>
            '<div class="row"><div class="grow"><div class="mono">' + untrusted(s.service) + "</div></div>" +
            '<button class="btn sm" data-connect="' + escapeHtml(s.service) + '">Connect</button></div>',
        )
        .join("") +
      "</div>";
  }
}

function renderTasks() {
  const tasks = (S && S.tasks && S.tasks.tasks) || [];
  $("tasks-count").textContent = String(tasks.length);
  const el = $("tasks-list");
  if (!tasks.length) {
    el.innerHTML = '<div class="empty">No tasks in the queue.</div>';
    return;
  }
  const cancellable = new Set(["running", "awaiting_confirmation", "needs_input"]);
  el.innerHTML =
    '<div class="rows">' +
    tasks
      .map(
        (t) =>
          '<div class="row"><div class="grow">' +
          '<div class="trunc">' + untrusted(t.label || t.goal) + "</div>" +
          '<div class="sub">' + escapeHtml(t.status) + " · " + escapeHtml(t.origin) + " · " + relTime(t.updatedAt) + "</div></div>" +
          (cancellable.has(t.status)
            ? '<button class="btn sm" data-cancel-task="' + escapeHtml(t.taskId) + '">Cancel</button>'
            : "") +
          "</div>",
      )
      .join("") +
    "</div>";
}

function renderPolicy() {
  const p = S && S.policy;
  $("policy-val").textContent = (p && p.effectiveDecision) || "—";
  const el = $("policy-list");
  if (!p || !p.entries || !p.entries.length) {
    el.innerHTML = '<div class="empty">No policy entries.</div>';
    return;
  }
  el.innerHTML =
    '<div class="rows">' +
    p.entries
      .map(
        (e) =>
          '<div class="row"><div class="grow">' +
          '<div class="mono trunc">' + untrusted(e.service) + ":" + untrusted(e.verb) + ":" + untrusted(e.noun) + "</div>" +
          '<div class="sub">' + escapeHtml(e.source) + " · priority " + e.priority + "</div></div>" +
          '<span class="badge" style="color:' +
          (e.decision === "allow" ? "var(--allow)" : "var(--deny)") + '">' + escapeHtml(e.decision) + "</span></div>",
      )
      .join("") +
    "</div>";
}

function renderAudit() {
  const el = $("audit-list");
  $("audit-count").textContent = auditEntries.length ? String(auditEntries.length) : "—";
  if (!auditEntries.length) {
    el.innerHTML =
      '<div class="empty">Audit log is empty. Governed actions are recorded here before they run.</div>';
    return;
  }
  const markOf = (e) => {
    if (e.decision === "allow") return ["allow", "✓"];
    if (e.decision === "deny") return ["deny", "✕"];
    if (e.decision === "pending") return ["pending", "●"];
    return ["event", "○"];
  };
  el.innerHTML = auditEntries
    .map((e) => {
      const m = markOf(e);
      return (
        '<div class="audit-row">' +
        '<span class="mark ' + m[0] + '">' + m[1] + "</span>" +
        '<span class="what">' + untrusted(e.service) + " · " + untrusted(e.verb) + " · " + untrusted(e.noun) + "</span>" +
        '<span class="when">' + relTime(e.timestamp) + "</span>" +
        '<span class="meta">' + escapeHtml(e.decision) + "/" + escapeHtml(e.outcome) +
        " · " + untrusted(e.toolName) + " · " + escapeHtml(e.epochId) + "/" + e.sequenceNum +
        (e.errorMessage ? " · " + untrusted(e.errorMessage) : "") +
        "</span></div>"
      );
    })
    .join("");
  $("btn-audit-more").disabled = !auditCursor || auditLoading;
  $("audit-note").textContent = auditCursor ? "more entries available" : "end of chain";
}

async function loadAudit(reset) {
  if (auditLoading) return;
  auditLoading = true;
  if (reset) {
    auditEntries = [];
    auditCursor = null;
  }
  const r = await act("audit", { cursor: auditCursor, limit: 50 });
  auditLoading = false;
  if (!r.ok) {
    toast("Could not read the audit log: " + escapeHtml(r.body.error || r.status), "err");
    return;
  }
  auditEntries = auditEntries.concat(r.body.entries || []);
  auditCursor = r.body.nextCursor || null;
  renderAudit();
}

function renderHeader() {
  const ok = Boolean(S && S.reachable);
  $("engine-dot").className = "dot " + (ok ? "ok" : "bad");
  $("engine-label").textContent = ok
    ? String(S.engineUrl || "").replace(/^https?:\/\//, "")
    : "engine unreachable";
  $("user-id").textContent = (S && S.userId) || "—";
  const sess = S && S.status && S.status.session;
  const chip = $("session-chip");
  if (sess) {
    chip.hidden = false;
    const left = minutesLeft(sess.expiry);
    $("session-val").textContent = left == null ? "active" : left + "m left";
  } else {
    chip.hidden = true;
  }
  $("btn-quit").disabled = !ok || !sess;
  $("btn-kill").disabled = !ok;
  $("btn-down").disabled = !ok;
  $("btn-up").disabled = ok;
}

function renderBanner() {
  const slot = $("banner-slot");
  if (S && S.reachable) {
    slot.innerHTML = "";
    return;
  }
  // An unreachable engine is the one condition where you believe you are
  // protected and are not, so it gets a loud card naming which ports were
  // tried — never a quiet empty queue.
  const ports = ((S && S.tried) || []).map((t) => t.port + (t.ok ? " ✓" : " ✕")).join("  ");
  slot.innerHTML =
    '<div class="banner"><h3>No engine is answering — you are not being protected right now</h3>' +
    "<p>This console cannot see held calls, so an empty queue below means nothing. " +
    (S && S.error ? 'Last error: <span class="mono">' + escapeHtml(S.error) + "</span>" : "") +
    "</p>" +
    '<div class="ports">tried ' + (ports || "—") + "</div>" +
    '<div style="margin-top:10px"><button class="btn" id="btn-banner-up">Start the engine</button></div></div>';
  const b = $("btn-banner-up");
  if (b) b.onclick = () => engineLifecycle("engineUp");
}

function renderAll() {
  // Stale marking is a whole-page fact, so it is set once per render.
  document.body.classList.toggle("stale", !(S && S.reachable));
  renderHeader();
  renderBanner();
  renderHeld();
  renderGrants();
  renderCaps();
  renderServices();
  renderTasks();
  renderPolicy();
}

// ── decisions ───────────────────────────────────────────────────────────────
/**
 * Answer one held call. Every branch that would strand a naive client is named
 * here, and in each of them the call STAYS PARKED — so the message says so
 * rather than letting the row vanish and implying a decision was reached.
 */
async function decide(heldCallId, choice) {
  const r = await act("resolve", { heldCallId, choice });
  if (r.ok) {
    if (r.body.status === "info") {
      const m = r.body.metadata || {};
      toast(
        "<b>" + untrusted(m.service) + " · " + untrusted(m.verb) + "</b><br>" +
        untrusted(m.description) +
        '<br><span style="color:var(--ink-3)">Still parked — no decision reached.</span>',
      );
    } else {
      const calls = (r.body.result && r.body.result.toolCalls) || [];
      const outcome = calls.map((c) => c.outcome).join(", ") || "resumed";
      toast(
        choice === "deny"
          ? "Denied. Nothing was granted and nothing ran."
          : "Approved — the call ran (" + escapeHtml(outcome) + "). It is in the audit log.",
        "ok",
      );
      if (choice !== "deny") loadAudit(true);
    }
    return;
  }
  const err = r.body.error || "HTTP " + r.status;
  const explain =
    r.status === 404
      ? "That hold has expired or was already answered — it is no longer parked."
      : r.status === 409
        ? "A turn is already in progress for this task. The call stays parked; try again in a moment."
        : r.status === 400
          ? "The engine refused that choice for this hold. The call stays parked."
          : "The call stays parked.";
  toast(
    escapeHtml(explain) + '<br><span class="mono" style="font-size:12px">' + escapeHtml(err) + "</span>",
    "err",
  );
}

async function engineLifecycle(which) {
  toast(which === "engineUp" ? "Starting the engine…" : "Stopping the engine…");
  const r = await act(which, {});
  const out = String(r.body.output || "").trim().split("\n").slice(-3).map(escapeHtml).join("<br>");
  toast(out || (r.ok ? "Done." : "Failed."), r.ok ? "ok" : "err");
}

// ── connect flow ────────────────────────────────────────────────────────────
// The OAuth consent page is opened by the browser we are already in — no
// platform opener is spawned, so the CLI's opener crash has no analogue here.
async function startConnect(service) {
  const r = await act("connect", { service });
  if (!r.ok) {
    toast("Could not start connect: " + escapeHtml(r.body.error || r.status), "err");
    return;
  }
  if (r.body.connected) {
    toast("Connected " + escapeHtml(r.body.connected) + ".", "ok");
    return;
  }
  const authorizeUrl = r.body.authorizeUrl;
  const flow = r.body.flow;
  const win = window.open(authorizeUrl, "_blank", "noopener,noreferrer");
  if (!win) {
    toast(
      'Popup blocked. Open this to authorize:<br><a href="' + escapeHtml(authorizeUrl) +
        '" target="_blank" rel="noopener noreferrer">' + escapeHtml(service) + " consent page</a>",
    );
  }
  toast("Waiting for " + escapeHtml(service) + " authorization…");
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 1500));
    const st = await act("connectStatus", { service, flow });
    if (!st.ok) continue;
    const s = st.body.status;
    if (s === "connected") {
      toast("Connected " + escapeHtml(service) + ".", "ok");
      return;
    }
    if (s === "denied") {
      toast("Authorization denied for " + escapeHtml(service) + ".", "err");
      return;
    }
    if (s === "expired") {
      toast("The " + escapeHtml(service) + " flow expired.", "err");
      return;
    }
  }
  // Every non-success exit issues the cleanup call so no pending row is orphaned.
  await act("connectCancel", { flow });
  toast("Gave up waiting for " + escapeHtml(service) + "; the flow was cancelled.", "err");
}

// ── events ──────────────────────────────────────────────────────────────────
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest(
    "[data-choice],[data-disconnect],[data-connect],[data-cancel-task],[data-tab],[data-idx]",
  );
  if (!t) return;

  if (t.dataset.choice) {
    t.disabled = true;
    await decide(t.dataset.id, t.dataset.choice);
    return;
  }
  if (t.dataset.disconnect) {
    const svc = t.dataset.disconnect;
    if (!confirm("Disconnect " + svc + "? Its stored credential is removed.")) return;
    const r = await act("disconnect", { service: svc });
    toast(
      r.ok ? "Disconnected " + escapeHtml(svc) + "." : "Failed: " + escapeHtml(r.body.error || r.status),
      r.ok ? "ok" : "err",
    );
    return;
  }
  if (t.dataset.connect) {
    startConnect(t.dataset.connect);
    return;
  }
  if (t.dataset.cancelTask) {
    const r = await act("cancelTask", { taskId: t.dataset.cancelTask });
    toast(
      r.ok ? "Task " + escapeHtml(r.body.status || "updated") + "." : "Failed: " + escapeHtml(r.body.error || r.status),
      r.ok ? "ok" : "err",
    );
    return;
  }
  if (t.dataset.tab) {
    servicesTab = t.dataset.tab;
    renderServices();
    return;
  }
  if (t.dataset.idx !== undefined) {
    selected = Number(t.dataset.idx);
    renderHeld();
  }
});

$("btn-kill").onclick = async () => {
  if (!confirm("Kill switch: clear every grant and set policy to deny?\n\nConnections and credentials are preserved."))
    return;
  const r = await act("kill", {});
  toast(
    r.ok
      ? "Kill switch activated — all grants cleared, policy set to deny."
      : "Failed: " + escapeHtml(r.body.error || r.status),
    r.ok ? "ok" : "err",
  );
};
$("btn-quit").onclick = async () => {
  if (!confirm("End the session? Grants expire and the slot frees. Connections are kept.")) return;
  const r = await act("quit", {});
  toast(r.ok ? "Session ended." : "Failed: " + escapeHtml(r.body.error || r.status), r.ok ? "ok" : "err");
};
$("btn-up").onclick = () => engineLifecycle("engineUp");
$("btn-down").onclick = () => engineLifecycle("engineDown");
$("btn-audit-more").onclick = () => loadAudit(false);

// Keyboard-first triage. The numbers match the CLI's prompt, so the muscle
// memory carries over. Ignored while typing in a field.
document.addEventListener("keydown", (ev) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const held = (S && S.status && S.status.held) || [];
  if (ev.key === "j" || ev.key === "ArrowDown") {
    if (!held.length) return;
    selected = Math.min(held.length - 1, selected + 1);
    renderHeld();
    ev.preventDefault();
    return;
  }
  if (ev.key === "k" || ev.key === "ArrowUp") {
    if (!held.length) return;
    selected = Math.max(0, selected - 1);
    renderHeld();
    ev.preventDefault();
    return;
  }
  const cur = held[selected];
  if (!cur) return;
  const map = { 1: "deny", 2: "tell_more", 3: "task", 4: "session" };
  const choice = map[ev.key];
  if (!choice) return;
  // Never offer the engine a choice it will reject for this hold's kind.
  if (cur.spend && (choice === "task" || choice === "session")) {
    toast("This is a spend hold — the affirmative answer is Approve once.", "err");
    return;
  }
  ev.preventDefault();
  decide(cur.heldCallId, choice);
});

// Tell the server whether anyone is looking, so it can slow the poll when
// nobody is. One poller serves every tab either way.
function reportFocus(focused) {
  if (DEMO) return;
  fetch("/api/focus", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ focused }),
    keepalive: true,
  }).catch(() => {});
}
let hadFocus = !document.hidden;
if (hadFocus) reportFocus(true);
document.addEventListener("visibilitychange", () => {
  const now = !document.hidden;
  if (now !== hadFocus) {
    hadFocus = now;
    reportFocus(now);
  }
});
window.addEventListener("pagehide", () => {
  if (hadFocus) reportFocus(false);
});

// ── the stream ──────────────────────────────────────────────────────────────
function connect() {
  if (DEMO) {
    window.HABENULA_DEMO.subscribe((next) => {
      S = next;
      renderAll();
    });
    return;
  }
  const es = new EventSource("/events");
  es.addEventListener("state", (ev) => {
    S = JSON.parse(ev.data);
    renderAll();
  });
  es.onerror = () => {
    // EventSource reconnects on its own; reflect the gap rather than hiding it.
    $("engine-dot").className = "dot bad";
    $("engine-label").textContent = "console disconnected";
  };
}
connect();
loadAudit(true);
// Relative timestamps drift; repaint them without re-fetching anything.
setInterval(() => {
  if (S) {
    renderGrants();
    renderServices();
    renderTasks();
  }
  if (auditEntries.length) renderAudit();
}, 30000);
