import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bridgeUrl, ensureBridgeRunning, formatBridgeInjectedPrompt, resolveBridgeLaunch } from "../.github/extensions/uhura/src/uhura-bridge-client.mjs";
import { createBridgeServer } from "../.github/extensions/uhura/src/uhura-bridge-server.mjs";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function withBridgeServer(testFn) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "uhura-bridge-"));
    const server = createBridgeServer({ databasePath: join(root, "bridge.sqlite") });
    const address = await listen(server);
    const base = `http://127.0.0.1:${address.port}`;
    try {
      await testFn(base, root);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test("bridge queues Scout messages for registered Uhura sessions and records events", withBridgeServer(async (base) => {
    const register = await fetch(`${base}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "captain-12345678", sessionId: "session-1", alias: "captain", shortId: "12345678", cwd: "C:\\repo" }),
    }).then((response) => response.json());
    assert.equal(register.ok, true);
    assert.equal(register.session.route, "captain-12345678");
    assert.equal(register.session.alias, "repo");

    const queued = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "captain-12345678", from: "Scout", prompt: "run tests" }),
    }).then((response) => response.json());
    assert.equal(queued.ok, true);
    assert.equal(queued.accepted[0].route, "captain-12345678");

    const poll = await fetch(`${base}/sessions/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "captain-12345678" }),
    }).then((response) => response.json());
    assert.equal(poll.ok, true);
    assert.equal(poll.messages[0].from, "Scout");
    assert.equal(poll.messages[0].prompt, "run tests");

    const sessions = await fetch(`${base}/sessions`).then((response) => response.json());
    assert.equal(sessions.sessions[0].pendingMessages, 0);
}));

test("bridge persists Copilot session display names and aliases", withBridgeServer(async (base) => {
    const register = await fetch(`${base}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        route: "fix-scout-bridge-12345678",
        sessionId: "session-1",
        alias: "captain",
        shortId: "12345678",
        displayName: "Fix Scout Bridge",
        names: ["Fix Scout Bridge", "fix-scout-bridge"],
        cwd: "C:\\repo",
      }),
    }).then((response) => response.json());

    assert.equal(register.session.displayName, "Fix Scout Bridge");
    assert.equal(register.session.alias, "fix-scout-bridge");
    assert.deepEqual(register.session.names, ["Fix Scout Bridge", "fix-scout-bridge", "12345678", "fix-scout-bridge-12345678"]);
    const sessions = await fetch(`${base}/sessions`).then((response) => response.json());
    assert.equal(sessions.sessions[0].displayName, "Fix Scout Bridge");
    assert.equal(sessions.sessions[0].alias, "fix-scout-bridge");
}));

test("bridge records one registration event for repeated session heartbeats", withBridgeServer(async (base) => {
    const body = JSON.stringify({
      route: "uhura-create-12345678",
      sessionId: "session-1",
      alias: "uhura-create",
      shortId: "12345678",
      displayName: "uhura-create",
      cwd: "C:\\repo\\uhura",
    });
    for (let i = 0; i < 3; i += 1) {
      const registered = await fetch(`${base}/sessions/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }).then((response) => response.json());
      assert.equal(registered.ok, true);
    }

    const events = await fetch(`${base}/events`).then((response) => response.json());
    assert.deepEqual(events.events.map((event) => event.type), ["session.registered"]);
}));

test("bridge exposes session availability without event noise", withBridgeServer(async (base) => {
    const busy = await fetch(`${base}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        route: "uhura-create-12345678",
        sessionId: "session-1",
        alias: "uhura-create",
        shortId: "12345678",
        displayName: "uhura-create",
        activityStatus: "busy",
        activityUpdatedAt: "2026-07-06T17:00:00.000Z",
      }),
    }).then((response) => response.json());
    assert.equal(busy.session.activityStatus, "busy");
    assert.equal(busy.session.isBusy, true);
    assert.equal(busy.session.isIdle, false);
    assert.equal(busy.session.isWaiting, false);
    assert.equal(busy.session.activityUpdatedAt, "2026-07-06T17:00:00.000Z");

    const idle = await fetch(`${base}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        route: "uhura-create-12345678",
        sessionId: "session-1",
        alias: "uhura-create",
        shortId: "12345678",
        displayName: "uhura-create",
        activityStatus: "idle",
        activityUpdatedAt: "2026-07-06T17:01:00.000Z",
      }),
    }).then((response) => response.json());
    assert.equal(idle.session.activityStatus, "idle");
    assert.equal(idle.session.isBusy, false);
    assert.equal(idle.session.isIdle, true);
    assert.equal(idle.session.isWaiting, false);
    assert.equal(idle.session.activityUpdatedAt, "2026-07-06T17:01:00.000Z");

    const waiting = await fetch(`${base}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        route: "uhura-create-12345678",
        sessionId: "session-1",
        alias: "uhura-create",
        shortId: "12345678",
        displayName: "uhura-create",
        activityStatus: "waiting",
        activityUpdatedAt: "2026-07-06T17:02:00.000Z",
      }),
    }).then((response) => response.json());
    assert.equal(waiting.session.activityStatus, "waiting");
    assert.equal(waiting.session.isBusy, false);
    assert.equal(waiting.session.isIdle, false);
    assert.equal(waiting.session.isWaiting, true);

    const sessions = await fetch(`${base}/sessions`).then((response) => response.json());
    assert.equal(sessions.sessions[0].activityStatus, "waiting");
    assert.equal(sessions.sessions[0].isWaiting, true);

    const events = await fetch(`${base}/events`).then((response) => response.json());
    assert.deepEqual(events.events.map((event) => event.type), ["session.registered"]);
}));

test("bridge records Scout replies and explicit notifications without routine assistant chatter", withBridgeServer(async (base) => {
    const routine = await fetch(`${base}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        route: "uhura-create-12345678",
        type: "assistant.message",
        content: "routine assistant progress",
        messageId: "routine-1",
      }),
    }).then((response) => response.json());
    assert.equal(routine.ok, true);
    assert.equal(routine.ignored, true);

    const reply = await fetch(`${base}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        route: "uhura-create-12345678",
        type: "assistant.message",
        content: "reply to Scout",
        messageId: "reply-1",
        replyToMessageId: "scout-1",
      }),
    }).then((response) => response.json());
    assert.equal(reply.event.type, "assistant.message");
    assert.equal(reply.event.replyToMessageId, "scout-1");

    const notification = await fetch(`${base}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        route: "uhura-create-12345678",
        type: "notification.message",
        content: "explicit notification",
        messageId: "notification-1",
      }),
    }).then((response) => response.json());
    assert.equal(notification.event.type, "notification.message");

    const events = await fetch(`${base}/events`).then((response) => response.json());
    assert.deepEqual(events.events.map((event) => event.type), ["assistant.message", "notification.message"]);
}));

test("bridge normalizes legacy session aliases when listing sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "uhura-bridge-legacy-alias-"));
  const databasePath = join(root, "bridge.sqlite");
  const route = "fix-scout-bridge-12345678";
  try {
    const first = createBridgeServer({ databasePath });
    const firstAddress = await listen(first);
    const firstBase = `http://127.0.0.1:${firstAddress.port}`;
    await fetch(`${firstBase}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        route,
        sessionId: "session-1",
        alias: "captain",
        shortId: "12345678",
        displayName: "Fix Scout Bridge",
        names: ["Fix Scout Bridge", "fix-scout-bridge", "captain", "12345678", route],
      }),
    });
    await new Promise((resolve) => first.close(resolve));

    const database = new DatabaseSync(databasePath);
    try {
      database.prepare("UPDATE sessions SET alias = ?, names_json = ? WHERE route = ?")
        .run("captain", JSON.stringify(["Fix Scout Bridge", "fix-scout-bridge", "captain", "12345678", route]), route);
    } finally {
      database.close();
    }

    const second = createBridgeServer({ databasePath });
    const secondAddress = await listen(second);
    const secondBase = `http://127.0.0.1:${secondAddress.port}`;
    try {
      const sessions = await fetch(`${secondBase}/sessions`).then((response) => response.json());
      assert.equal(sessions.sessions[0].alias, "fix-scout-bridge");
      assert.deepEqual(sessions.sessions[0].names, ["Fix Scout Bridge", "fix-scout-bridge", "12345678", route]);
    } finally {
      await new Promise((resolve) => second.close(resolve));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge client URL defaults to localhost bridge", () => {
  assert.equal(bridgeUrl(undefined, "health"), "http://127.0.0.1:47871/health");
  assert.equal(bridgeUrl({ url: "http://127.0.0.1:5000" }, "sessions"), "http://127.0.0.1:5000/sessions");
});

test("bridge injected prompt directs replies through assistant events", () => {
  const prompt = formatBridgeInjectedPrompt({ from: "Scout", prompt: "SCOUT-PING-57173" });

  assert.match(prompt, /Reply normally in this Copilot CLI session/);
  assert.match(prompt, /Uhura will mirror your assistant response back to Scout through the bridge event stream/);
  assert.match(prompt, /uhura_send is only for explicit Teams Graph sends/);
  assert.match(prompt, /SCOUT-PING-57173/);
});

test("bridge rejects unknown direct routes with available route guidance", withBridgeServer(async (base) => {
    await fetch(`${base}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "captain-12345678", sessionId: "session-1" }),
    });

    const response = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "captain-wrong", from: "Scout", prompt: "hello" }),
    });
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.ok, false);
    assert.deepEqual(body.rejected, ["captain-wrong"]);
    assert.deepEqual(body.availableRoutes, ["captain-12345678"]);
}));

test("bridge reports no registered sessions for target all", withBridgeServer(async (base) => {
    const response = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "all", from: "Scout", prompt: "hello" }),
    });
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.ok, false);
    assert.deepEqual(body.availableRoutes, []);
}));

test("bridge persists queued messages and events across process restarts", async () => {
  const root = mkdtempSync(join(tmpdir(), "uhura-bridge-durable-"));
  const databasePath = join(root, "bridge.sqlite");
  try {
    const first = createBridgeServer({ databasePath });
    const firstAddress = await listen(first);
    const firstBase = `http://127.0.0.1:${firstAddress.port}`;
    await fetch(`${firstBase}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "captain-12345678", sessionId: "session-1", alias: "captain", shortId: "12345678" }),
    });
    const queued = await fetch(`${firstBase}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "captain-12345678", from: "Scout", prompt: "survive restart" }),
    }).then((response) => response.json());
    assert.equal(queued.accepted[0].route, "captain-12345678");
    await new Promise((resolve) => first.close(resolve));

    const second = createBridgeServer({ databasePath });
    const secondAddress = await listen(second);
    const secondBase = `http://127.0.0.1:${secondAddress.port}`;
    try {
      const sessions = await fetch(`${secondBase}/sessions`).then((response) => response.json());
      assert.equal(sessions.sessions[0].route, "captain-12345678");
      assert.equal(sessions.sessions[0].pendingMessages, 1);

      const poll = await fetch(`${secondBase}/sessions/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route: "captain-12345678" }),
      }).then((response) => response.json());
      assert.equal(poll.messages[0].prompt, "survive restart");

      const events = await fetch(`${secondBase}/events`).then((response) => response.json());
      assert.equal(events.events.some((event) => event.type === "message.queued" && event.route === "captain-12345678"), true);
    } finally {
      await new Promise((resolve) => second.close(resolve));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge autostart launch is localhost-only and points at bridge script", () => {
  const launch = resolveBridgeLaunch({ url: "http://127.0.0.1:5000", tokenFile: "C:\\token.txt" });

  assert.equal(launch.command, "node");
  assert.equal(launch.host, "127.0.0.1");
  assert.equal(launch.port, 5000);
  assert.match(launch.args[0], /scripts[\\\/]uhura-bridge\.mjs$/);
  assert.deepEqual(launch.args.slice(1), ["--host", "127.0.0.1", "--port", "5000", "--token-file", "C:\\token.txt"]);
  assert.throws(() => resolveBridgeLaunch({ url: "http://example.com:5000" }), /localhost/);
});

test("bridge autostart starts only when health is unavailable", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false });
    const spawned = [];
    const status = await ensureBridgeRunning(
      { enabled: true, url: "http://127.0.0.1:5001", nodePath: "C:\\tools\\node.exe" },
      {
        spawnFn: (command, args, options) => {
          spawned.push({ command, args, options });
          return { unref() {} };
        },
      },
    );

    assert.equal(status, "started");
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].command, "C:\\tools\\node.exe");

    globalThis.fetch = async (_url, options) => {
      assert.equal(options.headers.Authorization, "Bearer abc");
      return { ok: true };
    };
    const running = await ensureBridgeRunning({
      enabled: true,
      url: "http://127.0.0.1:5001",
      tokenFile: fileURLToPath(new URL("./fixtures/bridge-token.txt", import.meta.url)),
    });
    assert.equal(running, "running");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
