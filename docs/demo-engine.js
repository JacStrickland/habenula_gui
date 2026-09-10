"use strict";
// Fixture engine for the hosted demo.
//
// A hosted page cannot reach a real engine: an HTTPS page fetching
// http://127.0.0.1 is blocked as mixed content, and the engine's loopback guard
// rejects a browser Origin anyway. So the demo swaps the transport, not the UI —
// this object implements the same `act(name, body)` surface server.mjs exposes,
// and the console renders it with the same code it uses against a real engine.
//
// It is a fixture, and the page says so. What it does NOT do is fake the parts
// that matter: the audit chain below is really SHA-256 hash-chained, computed in
// the browser, so the tamper-evidence you see demonstrated is the real property
// and not a decorative string.

(function () {
  const listeners = new Set();
  const nowIso = () => new Date().toISOString();
  const uuid = () =>
    (crypto.randomUUID && crypto.randomUUID()) ||
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });

  const GENESIS = "GENESIS";
  let chainHead = GENESIS;
  let seq = 0;

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** Shapes of the parameter values, never the values — the same posture the
   *  real engine takes: the log records that a body of 40 chars was sent, not
   *  what it said. */
  function paramsMetadata(params) {
    const out = {};
    for (const [k, v] of Object.entries(params || {})) {
      out[k] = Array.isArray(v)
        ? { type: "array", length: v.length }
        : { type: typeof v, length: typeof v === "string" ? v.length : undefined };
    }
    return JSON.stringify(out);
  }

  const state = {
    engineUrl: "demo (no engine — fixture data)",
    reachable: true,
    tried: [],
    userId: "cli-user",
    status: {
      session: {
        sessionId: "session-" + uuid(),
        startedAt: nowIso(),
        expiry: new Date(Date.now() + 89 * 60000).toISOString(),
      },
      grants: [],
      held: [],
      auditTail: { hash: GENESIS, prevHash: GENESIS },
    },
    settings: {
      monthLimitCents: 5000,
      sessionLimitCents: 2000,
      monthIsDefault: true,
      sessionIsDefault: true,
      monthSpentCents: 0,
      sessionSpentCents: 0,
    },
    policy: {
      effectiveDecision: "deny",
      entries: [
        {
          id: "default-deny",
          source: "standing",
          service: "*",
          verb: "*",
          noun: "*",
          decision: "deny",
          priority: 0,
          createdAt: nowIso(),
          expiresAt: null,
        },
      ],
    },
    services: { services: [{ service: "mock_email", connected_at: nowIso() }] },
    catalog: {
      services: [
        { service: "gmail" },
        { service: "mock_email" },
        { service: "mock_delivery" },
        { service: "slack" },
        { service: "google_calendar" },
        { service: "github" },
        { service: "outlook_mail" },
        { service: "habenula" },
      ],
    },
    tasks: { tasks: [] },
    error: null,
    lastOk: nowIso(),
  };

  let audit = [];

  // ── the fixtures ──────────────────────────────────────────────────────────
  // Three holds, chosen to show the three shapes a decision actually takes.
  function seedHolds() {
    return [
      {
        heldCallId: uuid(),
        service: "mock_email",
        verb: "send",
        noun: "sam@example.com",
        params: {
          to: ["sam@example.com"],
          subject: "Q3 numbers",
          body: "Revenue was up 12% quarter over quarter.",
        },
      },
      {
        // Commissioned by an external agent over MCP — carries its goal.
        heldCallId: uuid(),
        service: "github",
        verb: "create_issue",
        noun: "habenula-ai/habenula-oss",
        origin: "mcp_commission",
        goal: "File the browser-opener crash upstream with both stack traces.",
        params: {
          repo: "habenula-ai/habenula-oss",
          title: "habenula connect crashes with an unhandled 'error' event",
          body: "spawn reports ENOENT asynchronously; the try/catch never sees it.",
        },
      },
      {
        // A recipient carrying a right-to-left override (U+202E) and a
        // zero-width space (U+200B) — the trick for making one address read as
        // another. The console flags it rather than stripping it.
        heldCallId: uuid(),
        service: "mock_email",
        verb: "send",
        noun: "sam@example.com‮​evil@attacker.test",
        params: {
          to: ["sam@example.com‮​evil@attacker.test"],
          subject: "Invoice",
          body: "Please pay.",
        },
      },
      {
        // A spend hold: takes approve_once, refuses the grant-minting choices.
        heldCallId: uuid(),
        service: "mock_delivery",
        verb: "place_order",
        noun: "order #4471",
        params: { items: ["2x cable"], total: "34.00" },
        spend: {
          amountCents: 3400,
          summary: "2x USB-C cable",
          reason: "over_limit",
          breaches: [{ window: "session", limitCents: 2000, spentCents: 0 }],
        },
      },
    ];
  }

  async function appendAudit(hold, decision, outcome) {
    const entry = {
      epochId: new Date().toISOString().slice(0, 10),
      sequenceNum: seq++,
      prevHash: chainHead,
      id: uuid(),
      timestamp: nowIso(),
      userId: state.userId,
      agentId: "demo",
      sessionId: state.status.session ? state.status.session.sessionId : "-",
      origin: hold.origin === "mcp_commission" ? "mcp_commission" : "human",
      service: hold.service,
      verb: hold.verb,
      noun: hold.noun,
      toolName: hold.service + "_" + hold.verb,
      parametersMetadata: paramsMetadata(hold.params),
      decision,
      outcome,
      errorMessage: null,
      decisionEntryId: null,
      latencyMs: Math.round(8 + Math.random() * 40),
      costUsd: null,
      epochPrevHash: null,
    };
    // Hash over the entry's own content plus the previous hash — the link that
    // makes the log tamper-evident. Recomputing the chain reproduces these.
    entry.hash = await sha256Hex(
      [entry.prevHash, entry.id, entry.timestamp, entry.service, entry.verb, entry.noun,
       entry.toolName, entry.parametersMetadata, entry.decision, entry.outcome].join("|"),
    );
    chainHead = entry.hash;
    state.status.auditTail = { hash: entry.hash, prevHash: entry.prevHash };
    audit = [entry].concat(audit);
  }

  function emit() {
    const snap = JSON.parse(JSON.stringify(state));
    for (const fn of listeners) fn(snap);
  }

  function findHold(id) {
    return state.status.held.find((h) => h.heldCallId === id);
  }

  const TOOL_DESCRIPTIONS = {
    mock_email_send:
      "Send an email from the user's mock email account, an onboarding sandbox — the send is acknowledged but no real email is transmitted.",
    github_create_issue:
      "Open an issue on a GitHub repository the user has connected. Writes to the repository's public issue tracker.",
    mock_delivery_place_order:
      "Place an order through the mock delivery service. Spending is counted against your caps when the order is placed.",
  };

  const ok = (body) => ({ ok: true, status: 200, body });
  const fail = (status, error) => ({ ok: false, status, body: { error } });

  const actions = {
    async resolve({ heldCallId, choice }) {
      const hold = findHold(heldCallId);
      // The same 404 a real engine returns for a hold already answered — the
      // branch that strands a naive client, so the demo exercises it too.
      if (!hold) return fail(404, "held call not found");

      if (choice === "tell_more") {
        const name = hold.service + "_" + hold.verb;
        return ok({
          status: "info",
          metadata: {
            service: hold.service,
            verb: hold.verb,
            noun: hold.noun,
            description: TOOL_DESCRIPTIONS[name] || "No description registered for this tool.",
          },
        });
      }
      const isSpend = Boolean(hold.spend);
      if (isSpend && (choice === "task" || choice === "session")) {
        return fail(400, "a spend hold cannot mint a grant; use approve_once");
      }
      if (!isSpend && choice === "approve_once") {
        return fail(400, "approve_once is only valid on a spend hold");
      }

      state.status.held = state.status.held.filter((h) => h.heldCallId !== heldCallId);

      if (choice === "deny") {
        await appendAudit(hold, "deny", "denied");
        emit();
        return ok({
          status: "resumed",
          result: { response: "", toolCalls: [{ name: hold.service + "_" + hold.verb, id: heldCallId, outcome: "denied" }] },
        });
      }

      // A session grant persists until the session ends; a task grant is
      // consumed the moment its call runs, so it is never added to the list.
      if (choice === "session") {
        state.status.grants.push({
          service: hold.service,
          verb: hold.verb,
          noun: hold.noun,
          source: "session",
          expiresAt: state.status.session ? state.status.session.expiry : null,
        });
      }
      if (isSpend && hold.spend.amountCents) {
        state.settings.sessionSpentCents += hold.spend.amountCents;
        state.settings.monthSpentCents += hold.spend.amountCents;
      }
      await appendAudit(hold, "allow", "success");
      emit();
      return ok({
        status: "resumed",
        result: { response: "", toolCalls: [{ name: hold.service + "_" + hold.verb, id: heldCallId, outcome: "success" }] },
      });
    },

    async kill() {
      state.status.grants = [];
      state.policy.effectiveDecision = "deny";
      emit();
      return ok({ killed: true });
    },

    async quit() {
      state.status.session = null;
      state.status.grants = [];
      emit();
      return ok({ ended: true });
    },

    async disconnect({ service }) {
      state.services.services = state.services.services.filter((s) => s.service !== service);
      emit();
      return ok({ disconnected: service, removed: true });
    },

    async connect({ service }) {
      // Only the mock provider is credential-less; everything else would need a
      // real OAuth client pair, which a demo cannot have.
      if (service.startsWith("mock_")) {
        if (!state.services.services.some((s) => s.service === service)) {
          state.services.services.push({ service, connected_at: nowIso() });
        }
        emit();
        return ok({ connected: service });
      }
      return fail(
        400,
        service + " needs an OAuth client pair and a real engine — connect it from the local console.",
      );
    },

    async connectStatus() {
      return ok({ status: "pending" });
    },
    async connectCancel() {
      return ok({ cancelled: true });
    },

    async caps({ monthLimitCents, sessionLimitCents }) {
      if (Number.isInteger(monthLimitCents)) {
        state.settings.monthLimitCents = monthLimitCents;
        state.settings.monthIsDefault = false;
      }
      if (Number.isInteger(sessionLimitCents)) {
        state.settings.sessionLimitCents = sessionLimitCents;
        state.settings.sessionIsDefault = false;
      }
      emit();
      return ok(state.settings);
    },

    async cancelTask({ taskId }) {
      const t = state.tasks.tasks.find((x) => x.taskId === taskId);
      if (!t) return fail(404, "task not found");
      const previousStatus = t.status;
      t.status = "cancelled";
      t.updatedAt = nowIso();
      emit();
      return ok({ status: "cancelled", taskId, previousStatus });
    },

    async audit({ cursor, limit }) {
      const size = limit || 50;
      const start = cursor ? Number(cursor) : 0;
      const slice = audit.slice(start, start + size);
      const next = start + size < audit.length ? String(start + size) : null;
      return ok({ entries: slice, nextCursor: next });
    },

    async taskDetail({ taskId }) {
      const t = state.tasks.tasks.find((x) => x.taskId === taskId);
      if (!t) return fail(404, "task not found");
      return ok({ task: t, statusDetail: null, awaitedSlotKeys: null });
    },

    // Lifecycle has no meaning without a real engine; say so rather than
    // pretending a button worked.
    async engineUp() {
      return fail(501, "This is the hosted demo — there is no engine to start. Run the console locally.");
    },
    async engineDown() {
      return fail(501, "This is the hosted demo — there is no engine to stop. Run the console locally.");
    },

    async resetDemo() {
      state.status.held = seedHolds();
      state.status.grants = [];
      state.status.session = {
        sessionId: "session-" + uuid(),
        startedAt: nowIso(),
        expiry: new Date(Date.now() + 89 * 60000).toISOString(),
      };
      state.settings.sessionSpentCents = 0;
      state.settings.monthSpentCents = 0;
      state.tasks.tasks = [
        {
          taskId: uuid(),
          origin: "mcp_commission",
          status: "awaiting_confirmation",
          label: "File the upstream crash report",
          goal: "File the browser-opener crash upstream with both stack traces.",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      ];
      emit();
      return ok({ reset: true });
    },
  };

  window.HABENULA_DEMO = {
    act(name, body) {
      const fn = actions[name];
      if (!fn) return Promise.resolve(fail(404, "unknown action " + name));
      return fn(body || {});
    },
    subscribe(fn) {
      listeners.add(fn);
      fn(JSON.parse(JSON.stringify(state)));
    },
    reset: () => actions.resetDemo(),
  };

  // Seed on load.
  actions.resetDemo();
})();
