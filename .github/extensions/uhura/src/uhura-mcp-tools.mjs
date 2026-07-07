import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defaultBridgeDiscoveryPath } from "./uhura-bridge-store.mjs";

const DEFAULT_BASE_URL = "http://127.0.0.1:47871";

function endpoint(baseUrl, path) {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function endpoints(baseUrl) {
  return {
    baseUrl,
    healthUrl: endpoint(baseUrl, "health"),
    sessionsUrl: endpoint(baseUrl, "sessions"),
    messagesUrl: endpoint(baseUrl, "messages"),
    eventsUrl: endpoint(baseUrl, "events"),
  };
}

function parseJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function requestJson(url, body, fetchFn) {
  const response = await fetchFn(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  });
  const text = await response.text();
  const data = text.length > 0 ? JSON.parse(text) : {};
  if (!response.ok || data.ok === false) {
    throw new Error(data.error ?? `${response.status} ${response.statusText}`);
  }
  return data;
}

async function probeBridge(discovery, fetchFn) {
  try {
    const health = await requestJson(discovery.healthUrl, undefined, fetchFn);
    return { ok: true, discovery, health };
  } catch (err) {
    return {
      ok: false,
      discovery,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function sessionNames(session) {
  const cwdName = typeof session.cwd === "string" && session.cwd.length > 0
    ? basename(session.cwd)
    : undefined;
  return [
    session.route,
    session.shortId,
    session.alias,
    session.displayName,
    ...(Array.isArray(session.names) ? session.names : []),
    cwdName,
  ].filter((value) => typeof value === "string" && value.length > 0);
}

export function resolveSessionTarget(sessions, target) {
  const normalized = String(target ?? "").trim().toLowerCase();
  if (normalized.length === 0) {
    return { ok: false, error: "target is required", matches: [] };
  }
  if (normalized === "all") {
    return { ok: true, all: true, matches: sessions };
  }

  const exactRoute = sessions.find((session) => session.route.toLowerCase() === normalized);
  if (exactRoute !== undefined) {
    return { ok: true, session: exactRoute, matches: [exactRoute] };
  }

  const matches = sessions.filter((session) => sessionNames(session).some((name) => name.toLowerCase() === normalized));
  if (matches.length === 1) {
    return { ok: true, session: matches[0], matches };
  }
  if (matches.length > 1) {
    return { ok: false, error: "target matched multiple Uhura sessions", matches };
  }
  return { ok: false, error: "target did not match a registered Uhura session", matches: [] };
}

export async function discoverUhura(options = {}) {
  const fetchFn = options.fetchFn ?? fetch;
  const discoveryFile = options.discoveryFile ?? defaultBridgeDiscoveryPath();
  if (existsSync(discoveryFile)) {
    const fromFile = parseJsonFile(discoveryFile);
    const probed = await probeBridge(fromFile, fetchFn);
    if (probed.ok) {
      return { ...probed, source: "discovery-file", discoveryFile };
    }
  }

  const canonical = endpoints(options.baseUrl ?? DEFAULT_BASE_URL);
  const probed = await probeBridge(canonical, fetchFn);
  if (probed.ok) {
    return { ...probed, source: "canonical-default", discoveryFile };
  }
  return {
    ok: false,
    source: "none",
    discoveryFile,
    discovery: canonical,
    error: probed.error,
  };
}

export async function listUhuraSessions(args = {}, options = {}) {
  const fetchFn = options.fetchFn ?? fetch;
  const discovery = await discoverUhura({ ...options, fetchFn });
  if (!discovery.ok) {
    return discovery;
  }
  const result = await requestJson(discovery.discovery.sessionsUrl, undefined, fetchFn);
  const sessions = result.sessions ?? [];
  return {
    ok: true,
    discovery: discovery.discovery,
    sessions,
    target: args.target === undefined ? undefined : resolveSessionTarget(sessions, args.target),
  };
}

export async function sendUhuraMessage(args = {}, options = {}) {
  const prompt = String(args.prompt ?? "").trim();
  if (prompt.length === 0) {
    return { ok: false, error: "prompt is required" };
  }
  const target = args.route ?? args.to ?? args.target;
  const sessionResult = await listUhuraSessions({}, options);
  if (!sessionResult.ok) {
    return sessionResult;
  }
  const resolved = resolveSessionTarget(sessionResult.sessions, target);
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error,
      matches: resolved.matches,
      availableRoutes: sessionResult.sessions.map((session) => session.route),
    };
  }
  const body = resolved.all
    ? { target: "all", from: args.from ?? "Scout", prompt }
    : { route: resolved.session.route, from: args.from ?? "Scout", prompt };
  const result = await requestJson(sessionResult.discovery.messagesUrl, body, options.fetchFn ?? fetch);
  return {
    ok: true,
    target: resolved.all ? "all" : resolved.session.route,
    ...result,
  };
}

export async function listUhuraEvents(args = {}, options = {}) {
  const fetchFn = options.fetchFn ?? fetch;
  const discovery = await discoverUhura({ ...options, fetchFn });
  if (!discovery.ok) {
    return discovery;
  }
  const url = args.since === undefined
    ? discovery.discovery.eventsUrl
    : `${discovery.discovery.eventsUrl}?since=${encodeURIComponent(String(args.since))}`;
  const result = await requestJson(url, undefined, fetchFn);
  const events = (result.events ?? []).filter((event) => {
    if (args.route !== undefined && event.route !== args.route) {
      return false;
    }
    if (args.type !== undefined && event.type !== args.type) {
      return false;
    }
    return true;
  });
  return { ok: true, discovery: discovery.discovery, events };
}

export async function askUhura(args = {}, options = {}) {
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 120000), 1000), 600000);
  const startedAt = new Date().toISOString();
  const sent = await sendUhuraMessage(args, options);
  if (!sent.ok) {
    return sent;
  }
  if (sent.target === "all") {
    return { ok: false, error: "uhura_ask requires one target session", sent };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await listUhuraEvents({ route: sent.target, type: "assistant.message", since: startedAt }, options);
    if (events.ok && events.events.length > 0) {
      return { ok: true, sent, event: events.events[0] };
    }
    await delay(1000);
  }
  return { ok: false, error: "timed out waiting for assistant.message event", sent };
}

export const uhuraMcpToolDefinitions = [
  {
    name: "uhura_discover",
    description: "Discover the local Uhura bridge from bridge.json or the canonical localhost endpoint.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: (_args, options) => discoverUhura(options),
  },
  {
    name: "uhura_sessions",
    description: "List registered Uhura Copilot CLI sessions, optionally resolving a target name.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Optional route, short id, alias, or cwd basename to resolve." },
      },
    },
    handler: listUhuraSessions,
  },
  {
    name: "uhura_send",
    description: "Send a prompt to one Uhura session or to all registered sessions through the local bridge.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Route, short id, alias, cwd basename, or all." },
        route: { type: "string", description: "Exact Uhura route. Overrides to when provided." },
        prompt: { type: "string", description: "Prompt to inject into the target Copilot CLI session.", minLength: 1 },
        from: { type: "string", description: "Sender label shown to the target session.", default: "Scout" },
      },
      required: ["prompt"],
    },
    handler: sendUhuraMessage,
  },
  {
    name: "uhura_events",
    description: "Read Uhura bridge events, including assistant replies mirrored back from Copilot CLI sessions.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "Optional event id or ISO timestamp lower bound." },
        route: { type: "string", description: "Optional Uhura route filter." },
        type: { type: "string", description: "Optional event type filter." },
      },
    },
    handler: listUhuraEvents,
  },
  {
    name: "uhura_ask",
    description: "Send a prompt to one Uhura session and wait for the next assistant reply event from that route.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Route, short id, alias, or cwd basename." },
        route: { type: "string", description: "Exact Uhura route. Overrides to when provided." },
        prompt: { type: "string", description: "Prompt to inject into the target Copilot CLI session.", minLength: 1 },
        from: { type: "string", description: "Sender label shown to the target session.", default: "Scout" },
        timeoutMs: { type: "integer", description: "Maximum time to wait for an assistant reply event.", minimum: 1000, maximum: 600000 },
      },
      required: ["prompt"],
    },
    handler: askUhura,
  },
];
