import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSessionIdentity,
  formatOutboundMessage,
  loadConfig,
  parseRoutedMessage,
  parseTokenCommandOutput,
  readState,
  summarizeChatTargets,
  updateConfigTarget,
  updateState,
} from "../.github/extensions/uhura/src/uhura-core.mjs";

test("formats outbound Teams messages with a visible Uhura session route", () => {
  const identity = createSessionIdentity({ configuredAlias: "Captain", sessionId: "1234567890abcdef" });
  const html = formatOutboundMessage({ message: "build passed", identity });

  assert.match(html, /Uhura \[captain-12345678\]/);
  assert.match(html, /build passed/);
  assert.match(html, /@uhura captain-12345678/);
});

test("refreshes placeholder session identity with the runtime session id", () => {
  const placeholder = createSessionIdentity({ configuredAlias: "Captain" });
  const identity = createSessionIdentity({
    previous: placeholder,
    configuredAlias: "Captain",
    sessionId: "6c33d4e1-b1bb-4c38-804d-872732bd5df2",
  });

  assert.equal(placeholder.route, "captain-unknown");
  assert.equal(identity.route, "captain-6c33d4e1");
  assert.equal(identity.sessionId, "6c33d4e1-b1bb-4c38-804d-872732bd5df2");
});

test("uses Copilot session name for human route prefix when available", () => {
  const identity = createSessionIdentity({
    configuredAlias: "Captain",
    sessionId: "6c33d4e1-b1bb-4c38-804d-872732bd5df2",
    sessionName: "Fix Scout Bridge",
  });

  assert.equal(identity.route, "fix-scout-bridge-6c33d4e1");
  assert.equal(identity.alias, "fix-scout-bridge");
  assert.equal(identity.displayName, "Fix Scout Bridge");
  assert.deepEqual(identity.names, ["Fix Scout Bridge", "fix-scout-bridge", "6c33d4e1", "fix-scout-bridge-6c33d4e1"]);
});

test("uses cwd basename as alias before global configured alias", () => {
  const identity = createSessionIdentity({
    configuredAlias: "Captain",
    sessionId: "6c33d4e1-b1bb-4c38-804d-872732bd5df2",
    workingDirectory: "C:\\work\\repos\\uhura",
  });

  assert.equal(identity.alias, "uhura");
  assert.equal(identity.route, "uhura-6c33d4e1");
  assert.deepEqual(identity.names, ["uhura", "6c33d4e1", "uhura-6c33d4e1"]);
});


test("routes Teams replies by route, alias, short id, and broadcast", () => {
  const identity = createSessionIdentity({ configuredAlias: "Captain", sessionId: "1234567890abcdef" });

  assert.deepEqual(parseRoutedMessage({ html: "@uhura captain-12345678 run tests", handle: "uhura", identity, allowBroadcast: true }), { prompt: "run tests" });
  assert.deepEqual(parseRoutedMessage({ html: "@uhura captain check status", handle: "uhura", identity, allowBroadcast: true }), { prompt: "check status" });
  assert.deepEqual(parseRoutedMessage({ html: "@uhura 12345678 ship it", handle: "uhura", identity, allowBroadcast: true }), { prompt: "ship it" });
  assert.deepEqual(parseRoutedMessage({ html: "@uhura all report", handle: "uhura", identity, allowBroadcast: true }), { prompt: "report" });
});

test("ignores unrelated and outbound Uhura messages", () => {
  const identity = createSessionIdentity({ configuredAlias: "Captain", sessionId: "1234567890abcdef" });

  assert.equal(parseRoutedMessage({ html: "@uhura other nope", handle: "uhura", identity, allowBroadcast: true }), undefined);
  assert.equal(parseRoutedMessage({ html: "Uhura [captain-12345678]\nhello", handle: "uhura", identity, allowBroadcast: true }), undefined);
});

test("validates config targets", () => {
  const root = mkdtempSync(join(tmpdir(), "uhura-config-"));
  try {
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({
      graph: { accessTokenFile: join(root, "token.txt") },
      target: { type: "chat", chatId: "19:chat" },
    }), "utf8");

    const config = loadConfig(configPath);
    assert.equal(config.valid, true);
    assert.equal(config.target.type, "chat");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects empty chat targets", () => {
  const root = mkdtempSync(join(tmpdir(), "uhura-empty-target-"));
  try {
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({
      graph: { authMode: "teams" },
      target: { type: "chat", chatId: "" },
    }), "utf8");

    const config = loadConfig(configPath);
    assert.equal(config.valid, false);
    assert.equal(config.error, "Config target must be a chat with chatId or a channel with teamId and channelId.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects the Scout Clawpilot chat target", () => {
  const root = mkdtempSync(join(tmpdir(), "uhura-blocked-target-"));
  try {
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({
      graph: { authMode: "teams" },
      target: { type: "chat", chatId: "19:cdd028da-e108-419c-89a3-c032ce5f71f5_99fa64eb-feda-4f94-aecd-30637ca7bf2d@unq.gbl.spaces" },
    }), "utf8");

    const config = loadConfig(configPath);
    assert.equal(config.valid, false);
    assert.equal(config.error, "Blocked target: Scout/Clawpilot chat is reserved and must not be used by Uhura.");
    assert.throws(
      () => updateConfigTarget({ type: "chat", chatId: "19:cdd028da-e108-419c-89a3-c032ce5f71f5_99fa64eb-feda-4f94-aecd-30637ca7bf2d@unq.gbl.spaces" }, configPath),
      /Scout\/Clawpilot/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parses token command output from raw text and JSON envelopes", () => {
  assert.equal(parseTokenCommandOutput("Bearer abc\n"), "abc");
  assert.equal(parseTokenCommandOutput(JSON.stringify({ data: { accessToken: "xyz" } })), "xyz");
});

test("persists per-session seen message ids", () => {
  const root = mkdtempSync(join(tmpdir(), "uhura-state-"));
  try {
    const statePath = join(root, "state.json");
    updateState((draft) => {
      draft.sessions = { one: { seenMessageIds: ["a"] } };
    }, statePath);

    assert.deepEqual(readState(statePath), { sessions: { one: { seenMessageIds: ["a"] } } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("summarizes Teams chat targets without message content", () => {
  assert.deepEqual(summarizeChatTargets([
    {
      id: "19:chat",
      chatType: "oneOnOne",
      members: [
        { displayName: "Taylor Morgan" },
        { displayName: "Ada Lovelace" },
      ],
    },
    {
      id: "19:group",
      chatType: "group",
      topic: "Build room",
      members: [],
    },
  ]), [
    {
      id: "19:chat",
      type: "chat",
      chatType: "oneOnOne",
      label: "Taylor Morgan, Ada Lovelace",
    },
    {
      id: "19:group",
      type: "chat",
      chatType: "group",
      label: "Build room",
    },
  ]);
});

test("updates Uhura config target atomically while preserving graph auth mode", () => {
  const root = mkdtempSync(join(tmpdir(), "uhura-target-"));
  try {
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({
      graph: { authMode: "teams" },
      target: { type: "chat", chatId: "old" },
      polling: { enabled: false },
    }), "utf8");

    const updated = updateConfigTarget({ type: "chat", chatId: "19:new" }, configPath);
    assert.equal(updated.graph.authMode, "teams");
    assert.deepEqual(updated.target, { type: "chat", chatId: "19:new" });
    assert.deepEqual(loadConfig(configPath).target, { type: "chat", chatId: "19:new" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validates RSC app-only channel read config", () => {
  const root = mkdtempSync(join(tmpdir(), "uhura-rsc-config-"));
  try {
    const configPath = join(root, "config.json");
    const secretPath = join(root, "client-secret.txt");
    writeFileSync(secretPath, "secret", "utf8");
    writeFileSync(configPath, JSON.stringify({
      graph: { authMode: "teams" },
      channelRead: {
        mode: "rsc",
        tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
        clientId: "11111111-1111-1111-1111-111111111111",
        clientSecretFile: secretPath,
      },
      target: {
        type: "channel",
        teamId: "8fbb87ca-f37f-459a-bcc9-bf050242230e",
        channelId: "19:channel@thread.tacv2",
      },
    }), "utf8");

    assert.equal(loadConfig(configPath).valid, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("allows bridge-only config without Teams target", () => {
  const root = mkdtempSync(join(tmpdir(), "uhura-bridge-config-"));
  try {
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({
      bridge: {
        enabled: true,
        url: "http://127.0.0.1:47871",
      },
      session: {
        alias: "captain",
      },
    }), "utf8");

    const config = loadConfig(configPath);
    assert.equal(config.valid, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
