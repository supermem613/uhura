import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleMcpRequest } from "../.github/extensions/uhura/src/uhura-mcp-server.mjs";
import { discoverUhura, resolveSessionTarget, sendUhuraMessage } from "../.github/extensions/uhura/src/uhura-mcp-tools.mjs";
import { createBridgeServer } from "../.github/extensions/uhura/src/uhura-bridge-server.mjs";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("MCP initialize and tools list expose Uhura tools", async () => {
  const initialized = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(initialized.result.serverInfo.name, "uhura");

  const listed = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(listed.result.tools.some((tool) => tool.name === "uhura_send"), true);
  assert.equal(listed.result.tools.some((tool) => tool.name === "uhura_ask"), true);
});

test("MCP tool call wraps Uhura tool output as MCP text content", async () => {
  const response = await handleMcpRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "uhura_discover", arguments: {} } },
    {
      fetchFn: async () => jsonResponse({ ok: true, sessions: 0, events: 0 }),
      baseUrl: "http://127.0.0.1:47871",
      discoveryFile: join(tmpdir(), "missing-uhura-bridge.json"),
    },
  );

  assert.equal(response.result.isError, false);
  assert.match(response.result.content[0].text, /"ok": true/);
});

test("discover reads bridge manifest before using canonical default", async () => {
  const root = mkdtempSync(join(tmpdir(), "uhura-mcp-discover-"));
  try {
    const discoveryFile = join(root, "bridge.json");
    writeFileSync(discoveryFile, JSON.stringify({
      baseUrl: "http://127.0.0.1:5999",
      healthUrl: "http://127.0.0.1:5999/health",
      sessionsUrl: "http://127.0.0.1:5999/sessions",
      messagesUrl: "http://127.0.0.1:5999/messages",
      eventsUrl: "http://127.0.0.1:5999/events",
    }), "utf8");

    const requested = [];
    const result = await discoverUhura({
      discoveryFile,
      fetchFn: async (url) => {
        requested.push(url);
        return jsonResponse({ ok: true, sessions: 1, events: 2 });
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.source, "discovery-file");
    assert.deepEqual(requested, ["http://127.0.0.1:5999/health"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("send resolves cwd basename to a Uhura route and queues through the bridge", async () => {
  const root = mkdtempSync(join(tmpdir(), "uhura-mcp-send-"));
  const server = createBridgeServer({ databasePath: join(root, "bridge.sqlite") });
  const address = await listen(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${baseUrl}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        route: "captain-a78321ac",
        sessionId: "a78321ac-739b-4716-8fbf-fb669425ab6b",
        alias: "captain",
        shortId: "a78321ac",
        displayName: "Rotunda session",
        names: ["Rotunda session", "rotunda-session", "rotunda"],
        cwd: "C:\\Users\\marcusm\\repos\\rotunda",
      }),
    });

    const result = await sendUhuraMessage({ to: "rotunda", prompt: "SCOUT-PING" }, { baseUrl, discoveryFile: join(root, "missing.json") });
    assert.equal(result.ok, true);
    assert.equal(result.target, "captain-a78321ac");

    const poll = await fetch(`${baseUrl}/sessions/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "captain-a78321ac" }),
    }).then((response) => response.json());
    assert.equal(poll.messages[0].prompt, "SCOUT-PING");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("send resolves Copilot session display name to a Uhura route", async () => {
  const root = mkdtempSync(join(tmpdir(), "uhura-mcp-name-send-"));
  const server = createBridgeServer({ databasePath: join(root, "bridge.sqlite") });
  const address = await listen(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${baseUrl}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        route: "fix-scout-bridge-a78321ac",
        sessionId: "a78321ac-739b-4716-8fbf-fb669425ab6b",
        alias: "captain",
        shortId: "a78321ac",
        displayName: "Fix Scout Bridge",
        names: ["Fix Scout Bridge", "fix-scout-bridge", "a78321ac", "fix-scout-bridge-a78321ac"],
        cwd: "C:\\Users\\marcusm\\repos\\rotunda",
      }),
    });

    const result = await sendUhuraMessage({ to: "Fix Scout Bridge", prompt: "SCOUT-PING" }, { baseUrl, discoveryFile: join(root, "missing.json") });
    assert.equal(result.ok, true);
    assert.equal(result.target, "fix-scout-bridge-a78321ac");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("target resolution reports ambiguity instead of guessing", () => {
  const resolved = resolveSessionTarget([
    { route: "captain-one", alias: "captain", shortId: "one" },
    { route: "captain-two", alias: "captain", shortId: "two" },
  ], "captain");

  assert.equal(resolved.ok, false);
  assert.equal(resolved.matches.length, 2);
});
