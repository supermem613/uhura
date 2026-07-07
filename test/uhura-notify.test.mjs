import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionIdentity,
  formatAskNotification,
  formatIdleNotification,
  registerSessionEventHandlers,
  resolveNotifyConfig,
  shouldNotifyAsk,
  shouldNotifyIdle,
} from "../.github/extensions/uhura/src/uhura-core.mjs";

const identity = createSessionIdentity({ configuredAlias: "Captain", sessionId: "6c33d4e1-b1bb-4c38-804d-872732bd5df2" });

test("resolveNotifyConfig defaults idle and ask on with a 60s idle threshold", () => {
  const notify = resolveNotifyConfig({});
  assert.equal(notify.enabled, true);
  assert.equal(notify.onIdle, true);
  assert.equal(notify.onAsk, true);
  assert.equal(notify.idleThresholdMs, 60000);
});

test("resolveNotifyConfig honours explicit disables and threshold", () => {
  const notify = resolveNotifyConfig({ notify: { enabled: false, onIdle: false, onAsk: true, idleThresholdMs: 5000 } });
  assert.equal(notify.enabled, false);
  assert.equal(notify.onIdle, false);
  assert.equal(notify.onAsk, true);
  assert.equal(notify.idleThresholdMs, 5000);
});

test("resolveNotifyConfig clamps out-of-range idle thresholds", () => {
  assert.equal(resolveNotifyConfig({ notify: { idleThresholdMs: -10 } }).idleThresholdMs, 0);
  assert.equal(resolveNotifyConfig({ notify: { idleThresholdMs: 999999999 } }).idleThresholdMs, 3600000);
  assert.equal(resolveNotifyConfig({ notify: { idleThresholdMs: "nope" } }).idleThresholdMs, 60000);
});

test("shouldNotifyIdle fires only on a busy-to-idle transition past the threshold", () => {
  const notify = resolveNotifyConfig({ notify: { idleThresholdMs: 60000 } });
  assert.equal(shouldNotifyIdle(notify, { previousStatus: "busy", busyDurationMs: 90000 }), true);
  assert.equal(shouldNotifyIdle(notify, { previousStatus: "busy", busyDurationMs: 60000 }), true);
});

test("shouldNotifyIdle skips short turns and non-busy transitions", () => {
  const notify = resolveNotifyConfig({ notify: { idleThresholdMs: 60000 } });
  assert.equal(shouldNotifyIdle(notify, { previousStatus: "busy", busyDurationMs: 1000 }), false);
  assert.equal(shouldNotifyIdle(notify, { previousStatus: "waiting", busyDurationMs: 90000 }), false);
  assert.equal(shouldNotifyIdle(notify, { previousStatus: "idle", busyDurationMs: 90000 }), false);
});

test("shouldNotifyIdle respects disabled flags", () => {
  assert.equal(shouldNotifyIdle(resolveNotifyConfig({ notify: { enabled: false } }), { previousStatus: "busy", busyDurationMs: 90000 }), false);
  assert.equal(shouldNotifyIdle(resolveNotifyConfig({ notify: { onIdle: false } }), { previousStatus: "busy", busyDurationMs: 90000 }), false);
});

test("shouldNotifyAsk fires on the transition into waiting only", () => {
  const notify = resolveNotifyConfig({});
  assert.equal(shouldNotifyAsk(notify, { previousStatus: "busy" }), true);
  assert.equal(shouldNotifyAsk(notify, { previousStatus: "idle" }), true);
  assert.equal(shouldNotifyAsk(notify, { previousStatus: "waiting" }), false);
});

test("shouldNotifyAsk respects disabled flags", () => {
  assert.equal(shouldNotifyAsk(resolveNotifyConfig({ notify: { enabled: false } }), { previousStatus: "busy" }), false);
  assert.equal(shouldNotifyAsk(resolveNotifyConfig({ notify: { onAsk: false } }), { previousStatus: "busy" }), false);
});

test("formatIdleNotification names the route and rounds the turn duration to seconds", () => {
  const content = formatIdleNotification({ identity, busyDurationMs: 92500 });
  assert.match(content, /captain-6c33d4e1/);
  assert.match(content, /idle/i);
  assert.match(content, /93s/);
});

test("formatAskNotification includes a trimmed one-line question summary", () => {
  const content = formatAskNotification({ identity, question: "Which database should I use?\nExtra detail line" });
  assert.match(content, /captain-6c33d4e1/);
  assert.match(content, /Which database should I use\?/);
  assert.doesNotMatch(content, /Extra detail line/);
});

test("formatAskNotification falls back to a generic prompt when no question text is given", () => {
  const content = formatAskNotification({ identity, question: "" });
  assert.match(content, /captain-6c33d4e1/);
  assert.match(content, /waiting/i);
});

test("formatAskNotification caps very long questions", () => {
  const content = formatAskNotification({ identity, question: "x".repeat(500) });
  assert.ok(content.length < 300, `expected capped content, got length ${content.length}`);
});

test("registerSessionEventHandlers subscribes only to actionable session events", () => {
  const registered = [];
  const session = {
    on(eventName, handler) {
      registered.push({ eventName, handler });
    },
  };
  registerSessionEventHandlers(session, {
    onAssistantMessage() {},
    onSessionIdle() {},
    onElicitationRequested() {},
  });
  assert.deepEqual(registered.map((entry) => entry.eventName), [
    "assistant.message",
    "session.idle",
    "elicitation.requested",
  ]);
  assert.ok(registered.every((entry) => typeof entry.handler === "function"));
});
