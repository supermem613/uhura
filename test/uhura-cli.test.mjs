import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runUhuraCli } from "../.github/extensions/uhura/src/uhura-cli.mjs";
import { createBridgeServer } from "../.github/extensions/uhura/src/uhura-bridge-server.mjs";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
    readStdout: () => stdout,
    readStderr: () => stderr,
  };
}

test("CLI schema and tools expose Uhura MCP methods", async () => {
  const schemaOutput = capture();
  const schemaCode = await runUhuraCli(["schema", "--summary"], schemaOutput);
  assert.equal(schemaCode, 0);
  const schema = JSON.parse(schemaOutput.readStdout());
  assert.equal(schema.commandPaths.some((path) => path.join(" ") === "uhura_sessions"), true);
  assert.equal(schema.commandPaths.some((path) => path.join(" ") === "sessions"), true);

  const toolsOutput = capture();
  const toolsCode = await runUhuraCli(["tools"], toolsOutput);
  assert.equal(toolsCode, 0);
  const tools = JSON.parse(toolsOutput.readStdout());
  assert.equal(tools.tools.some((tool) => tool.name === "uhura_send"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "uhura_ask"), true);
});

test("CLI direct and generic calls route through Uhura MCP handlers", async () => {
  const root = mkdtempSync(join(tmpdir(), "uhura-cli-"));
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
        alias: "fix-scout-bridge",
        shortId: "a78321ac",
        displayName: "Fix Scout Bridge",
        cwd: "C:\\work\\repos\\rotunda",
      }),
    });

    const sessionsOutput = capture();
    const sessionsCode = await runUhuraCli([
      "sessions",
      "Fix Scout Bridge",
      "--base-url",
      baseUrl,
      "--discovery-file",
      join(root, "missing.json"),
    ], sessionsOutput);
    assert.equal(sessionsCode, 0);
    const sessions = JSON.parse(sessionsOutput.readStdout());
    assert.equal(sessions.target.session.route, "fix-scout-bridge-a78321ac");

    const sendOutput = capture();
    const sendCode = await runUhuraCli([
      "call",
      "uhura_send",
      "--args-json",
      JSON.stringify({ to: "Fix Scout Bridge", prompt: "SCOUT-PING" }),
      "--base-url",
      baseUrl,
      "--discovery-file",
      join(root, "missing.json"),
    ], sendOutput);
    assert.equal(sendCode, 0);
    const sent = JSON.parse(sendOutput.readStdout());
    assert.equal(sent.target, "fix-scout-bridge-a78321ac");

    const poll = await fetch(`${baseUrl}/sessions/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "fix-scout-bridge-a78321ac" }),
    }).then((response) => response.json());
    assert.equal(poll.messages[0].prompt, "SCOUT-PING");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
