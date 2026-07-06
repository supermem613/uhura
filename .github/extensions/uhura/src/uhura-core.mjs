import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { readAuthStatus, readIntegratedAccessTokenForPurpose } from "./uhura-auth.mjs";
import { readRscAccessToken } from "./uhura-rsc.mjs";

const execFileAsync = promisify(execFile);
const CONFIG_DIR = join(homedir(), ".copilot", "uhura");
const DEFAULT_CONFIG_PATH = join(CONFIG_DIR, "config.json");
const STATE_PATH = join(CONFIG_DIR, "state.json");
const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const BLOCKED_CHAT_IDS = new Set([
  "19:cdd028da-e108-419c-89a3-c032ce5f71f5_99fa64eb-feda-4f94-aecd-30637ca7bf2d@unq.gbl.spaces",
]);

export function buildConfigExample() {
  return {
    graph: {
      authMode: "teams",
    },
    target: {
      type: "chat",
      chatId: "19:example",
    },
    polling: {
      enabled: true,
      intervalMs: 15000,
    },
    routing: {
      handle: "uhura",
      allowBroadcast: true,
    },
    session: {
      alias: "captain",
    },
    bridge: {
      enabled: true,
      url: "http://127.0.0.1:47871",
      intervalMs: 2000,
      autoStart: true,
      databasePath: "C:\\Users\\marcusm\\.copilot\\uhura\\bridge.sqlite",
      discoveryFile: "C:\\Users\\marcusm\\.copilot\\uhura\\bridge.json",
    },
  };
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadConfig(path = DEFAULT_CONFIG_PATH) {
  if (!existsSync(path)) {
    return {
      valid: false,
      path,
      error: `Config file not found at ${path}`,
      polling: { enabled: false },
    };
  }

  const config = readJsonFile(path);
  const error = validateConfig(config);
  return {
    ...config,
    valid: error === undefined,
    path,
    error,
  };
}

export function updateConfigTarget(target, path = DEFAULT_CONFIG_PATH) {
  const config = existsSync(path) ? readJsonFile(path) : buildConfigExample();
  const nextConfig = {
    ...config,
    target: normalizeTarget(target),
  };
  const error = validateConfig(nextConfig);
  if (error !== undefined) {
    throw new Error(error);
  }
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(nextConfig, null, 2), "utf8");
  if (existsSync(path)) {
    rmSync(path);
  }
  renameSync(tempPath, path);
  return nextConfig;
}

function normalizeTarget(target) {
  if (target?.type === "chat" && typeof target.chatId === "string" && target.chatId.length > 0) {
    if (isBlockedChatId(target.chatId)) {
      throw new Error("Blocked target: Scout/Clawpilot chat is reserved and must not be used by Uhura.");
    }
    return { type: "chat", chatId: target.chatId };
  }
  if (
    target?.type === "channel"
    && typeof target.teamId === "string"
    && target.teamId.length > 0
    && typeof target.channelId === "string"
    && target.channelId.length > 0
  ) {
    return { type: "channel", teamId: target.teamId, channelId: target.channelId };
  }
  throw new Error("Target must be a chat with chatId or a channel with teamId and channelId.");
}

function validateConfig(config) {
  if (typeof config !== "object" || config === null) {
    return "Config must be a JSON object.";
  }
  const bridgeOnly = config.bridge?.enabled === true && config.target === undefined;
  if ((typeof config.graph !== "object" || config.graph === null) && !bridgeOnly) {
    return "Config requires graph settings.";
  }
  if (config.graph !== undefined && config.graph.authMode !== "teams" && typeof config.graph.accessTokenFile !== "string" && typeof config.graph.accessTokenCommand !== "object") {
    return "Config requires graph.authMode=\"teams\", graph.accessTokenFile, or graph.accessTokenCommand.";
  }
  if (config.channelRead?.mode === "rsc") {
    if (typeof config.channelRead.tenantId !== "string" || config.channelRead.tenantId.length === 0) {
      return "RSC channel read requires channelRead.tenantId.";
    }
    if (typeof config.channelRead.clientId !== "string" || config.channelRead.clientId.length === 0) {
      return "RSC channel read requires channelRead.clientId.";
    }
    if (typeof config.channelRead.clientSecretFile !== "string" || config.channelRead.clientSecretFile.length === 0) {
      return "RSC channel read requires channelRead.clientSecretFile.";
    }
  }
  if (typeof config.target !== "object" || config.target === null) {
    if (bridgeOnly) {
      return undefined;
    }
    return "Config requires a Teams target.";
  }
  if (config.target.type === "chat" && isBlockedChatId(config.target.chatId)) {
    return "Blocked target: Scout/Clawpilot chat is reserved and must not be used by Uhura.";
  }
  if (config.target.type === "chat" && typeof config.target.chatId === "string" && config.target.chatId.length > 0) {
    return undefined;
  }
  if (
    config.target.type === "channel"
    && typeof config.target.teamId === "string"
    && config.target.teamId.length > 0
    && typeof config.target.channelId === "string"
    && config.target.channelId.length > 0
  ) {
    return undefined;
  }
  return "Config target must be a chat with chatId or a channel with teamId and channelId.";
}

function isBlockedChatId(chatId) {
  return typeof chatId === "string" && BLOCKED_CHAT_IDS.has(chatId.toLowerCase());
}

export function describeConfig(config) {
  return {
    valid: config.valid === true,
    path: config.path,
    error: config.error,
    target: config.target?.type === "chat"
      ? { type: "chat", chatId: redact(config.target.chatId) }
      : config.target?.type === "channel"
        ? { type: "channel", teamId: redact(config.target.teamId), channelId: redact(config.target.channelId) }
        : undefined,
    tokenSource: config.graph?.authMode === "teams"
      ? "integrated-teams"
      : typeof config.graph?.accessTokenFile === "string"
      ? "file"
      : typeof config.graph?.accessTokenCommand === "object"
        ? "command"
        : undefined,
    auth: config.graph?.authMode === "teams" ? readAuthStatus() : undefined,
    bridge: config.bridge?.enabled === true
      ? {
        enabled: true,
        url: config.bridge.url ?? "http://127.0.0.1:47871",
        intervalMs: config.bridge.intervalMs ?? 2000,
        autoStart: config.bridge.autoStart !== false,
      }
      : undefined,
  };
}

function redact(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  if (value.length <= 8) {
    return "***";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function createSessionIdentity(input = {}) {
  const previous = input.previous ?? {};
  const rawSessionId = input.sessionId ?? previous.sessionId;
  const sessionId = typeof rawSessionId === "string" && rawSessionId.length > 0 ? rawSessionId : "unknown";
  const shortId = String(sessionId).replace(/[^a-zA-Z0-9-]/g, "").slice(0, 8) || "unknown";
  const repo = basename(input.workingDirectory ?? previous.workingDirectory ?? "");
  const displayName = typeof input.sessionName === "string" && input.sessionName.trim().length > 0
    ? input.sessionName.trim()
    : previous.displayName;
  const displaySlug = displayName === undefined ? undefined : slug(displayName);
  const configuredAlias = input.configuredAlias === undefined ? undefined : slug(input.configuredAlias);
  const repoAlias = repo.length > 0 ? slug(repo) : undefined;
  const alias = displaySlug ?? repoAlias ?? configuredAlias ?? previous.alias ?? "session";
  const routeBase = alias;
  const route = `${routeBase}-${shortId}`;
  return {
    sessionId,
    shortId,
    alias,
    displayName,
    names: uniqueStrings([displayName, displaySlug, alias, shortId, route]),
    route,
    workingDirectory: input.workingDirectory ?? previous.workingDirectory,
  };
}

export function slug(value) {
  const result = String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return result || "session";
}

export function uniqueStrings(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatOutboundMessage({ message, identity }) {
  const content = escapeHtml(message).replace(/\r?\n/g, "<br>");
  return `<div><strong>Uhura [${escapeHtml(identity.route)}]</strong></div><div>${content}</div><div><em>Reply with @uhura ${escapeHtml(identity.route)} &lt;message&gt; or @uhura all &lt;message&gt;.</em></div>`;
}

function htmlToText(html) {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function parseRoutedMessage({ html, handle, identity, allowBroadcast }) {
  const text = htmlToText(html);
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  if (/^Uhura\s+\[/i.test(firstLine)) {
    return undefined;
  }

  const match = new RegExp(`^@${escapeRegex(handle)}\\s+(\\S+)\\s+([\\s\\S]+)$`, "i").exec(text);
  if (match === null) {
    return undefined;
  }
  const target = match[1].toLowerCase();
  const prompt = match[2].trim();
  const acceptedTargets = new Set([
    identity.route.toLowerCase(),
    identity.alias.toLowerCase(),
    identity.shortId.toLowerCase(),
  ]);
  if ((allowBroadcast === true && target === "all") || acceptedTargets.has(target)) {
    return { prompt };
  }
  return undefined;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readAccessToken(config, purpose = "send") {
  if (purpose === "channel-read-rsc") {
    return readRscAccessToken(config.channelRead);
  }
  if (config.graph.authMode === "teams") {
    return readIntegratedAccessTokenForPurpose(purpose);
  }
  if (typeof config.graph.accessTokenFile === "string") {
    return readFileSync(config.graph.accessTokenFile, "utf8").trim().replace(/^Bearer\s+/i, "");
  }
  const command = config.graph.accessTokenCommand;
  if (typeof command?.tool !== "string") {
    throw new Error("graph.accessTokenCommand.tool must be a string.");
  }
  const { stdout } = await execFileAsync(command.tool, Array.isArray(command.args) ? command.args.map(String) : [], {
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return parseTokenCommandOutput(stdout);
}

export function parseTokenCommandOutput(stdout) {
  const trimmed = String(stdout).trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    const token = parsed.accessToken ?? parsed.token ?? parsed.data?.accessToken ?? parsed.data?.token;
    if (typeof token === "string" && token.length > 0) {
      return token.replace(/^Bearer\s+/i, "");
    }

  }
  if (trimmed.length > 0) {
    return trimmed.replace(/^Bearer\s+/i, "");
  }
  throw new Error("Token command returned no token.");
}

export function summarizeChatTargets(chats) {
  return chats.map((chat) => {
    const members = Array.isArray(chat.members)
      ? chat.members
        .map((member) => member?.displayName)
        .filter((displayName) => typeof displayName === "string" && displayName.length > 0)
      : [];
    return {
      id: String(chat.id),
      type: "chat",
      chatType: typeof chat.chatType === "string" ? chat.chatType : undefined,
      label: typeof chat.topic === "string" && chat.topic.length > 0
        ? chat.topic
        : members.length > 0
          ? members.join(", ")
          : String(chat.id),
    };
  });
}

function endpointFor(config, action) {
  if (config.target.type === "chat") {
    const base = `${GRAPH_ROOT}/chats/${encodeURIComponent(config.target.chatId)}/messages`;
    return action === "list" ? `${base}?$top=20` : base;
  }
  const base = `${GRAPH_ROOT}/teams/${encodeURIComponent(config.target.teamId)}/channels/${encodeURIComponent(config.target.channelId)}/messages`;
  return action === "list" ? `${base}?$top=20` : base;
}

export function createGraphClient(config) {
  if (config.valid !== true) {
    throw new Error(config.error ?? "Uhura config is invalid.");
  }
  return {
    async sendMessage(html) {
      return graphRequest(config, endpointFor(config, "send"), {
        method: "POST",
        purpose: "send",
        body: {
          body: {
            contentType: "html",
            content: html,
          },
        },
      });
    },
    async listMessages() {
      const result = await graphRequest(config, endpointFor(config, "list"), {
        method: "GET",
        purpose: config.target.type === "channel" ? "channel-read-rsc" : "read",
      });
      const values = Array.isArray(result.value) ? result.value : [];
      return values
        .map((message) => ({
          id: String(message.id),
          body: message.body,
          from: displaySender(message.from),
          createdDateTime: message.createdDateTime,
        }))
        .reverse();
    },
    async listTargets(top = 20) {
      const result = await graphRequest(config, `${GRAPH_ROOT}/me/chats?$top=${encodeURIComponent(String(top))}&$expand=members`, { method: "GET", purpose: "read" });
      return summarizeChatTargets(Array.isArray(result.value) ? result.value : []);
    },
  };
}

async function graphRequest(config, url, options) {
  const token = await readAccessToken(config, options.purpose);
  const response = await fetch(url, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const data = text.length > 0 ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data.error?.message ?? `${response.status} ${response.statusText}`;
    throw new Error(`Graph request failed: ${message}`);
  }
  return data;
}

function displaySender(from) {
  const user = from?.user?.displayName;
  const app = from?.application?.displayName;
  return typeof user === "string" ? user : typeof app === "string" ? app : undefined;
}

export function readState(path = STATE_PATH) {
  if (!existsSync(path)) {
    return {};
  }
  return readJsonFile(path);
}

export function updateState(mutator, path = STATE_PATH) {
  const state = readState(path);
  mutator(state);
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf8");
  if (existsSync(path)) {
    rmSync(path);
  }
  renameSync(tempPath, path);
  return state;
}
