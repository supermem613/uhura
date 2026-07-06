import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function readBridgeToken(config) {
  if (typeof config?.tokenFile !== "string" || config.tokenFile.length === 0) {
    return undefined;
  }
  return readFileSync(config.tokenFile, "utf8").trim();
}

export function bridgeHeaders(config) {
  const headers = {
    "Content-Type": "application/json",
  };
  const token = readBridgeToken(config);
  if (token !== undefined && token.length > 0) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export function bridgeUrl(config, path) {
  const base = typeof config?.url === "string" && config.url.length > 0
    ? config.url
    : "http://127.0.0.1:47871";
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

export function formatBridgeInjectedPrompt(message) {
  return [
    `Scout message routed through Uhura from ${message.from ?? "Scout"}:`,
    "",
    "Reply normally in this Copilot CLI session.",
    "Uhura will mirror your assistant response back to Scout through the bridge event stream.",
    "uhura_send is only for explicit Teams Graph sends.",
    "",
    message.prompt,
  ].join("\n");
}

export function resolveBridgeLaunch(config) {
  const url = new URL(bridgeUrl(config, "health"));
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("Uhura bridge autostart only supports localhost HTTP URLs.");
  }
  const host = url.hostname;
  const port = Number(url.port || 47871);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Uhura bridge URL must include a valid port.");
  }
  const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "scripts", "uhura-bridge.mjs");
  const args = [scriptPath, "--host", host, "--port", String(port)];
  if (typeof config?.tokenFile === "string" && config.tokenFile.length > 0) {
    args.push("--token-file", config.tokenFile);
  }
  if (typeof config?.databasePath === "string" && config.databasePath.length > 0) {
    args.push("--database", config.databasePath);
  }
  if (typeof config?.discoveryFile === "string" && config.discoveryFile.length > 0) {
    args.push("--discovery-file", config.discoveryFile);
  }
  return { command: config?.nodePath ?? "node", host, port, args };
}

export async function isBridgeHealthy(config) {
  try {
    const response = await fetch(bridgeUrl(config, "health"), {
      headers: bridgeHeaders(config),
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function ensureBridgeRunning(config, options = {}) {
  if (config?.enabled !== true) {
    return "disabled";
  }
  if (await isBridgeHealthy(config)) {
    return "running";
  }
  if (config.autoStart === false) {
    return "unavailable";
  }
  const launch = resolveBridgeLaunch(config);
  const spawnFn = options.spawnFn ?? spawn;
  const child = spawnFn(launch.command, launch.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref?.();
  return "started";
}

export async function bridgeRequest(config, path, body) {
  const response = await fetch(bridgeUrl(config, path), {
    method: body === undefined ? "GET" : "POST",
    headers: bridgeHeaders(config),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text.length > 0 ? JSON.parse(text) : {};
  if (!response.ok || data.ok === false) {
    throw new Error(data.error ?? `${response.status} ${response.statusText}`);
  }
  return data;
}

export async function registerBridgeSession(config, sessionInfo) {
  return bridgeRequest(config, "sessions/register", sessionInfo);
}

export async function pollBridgeMessages(config, route) {
  return bridgeRequest(config, "sessions/poll", { route });
}

export async function postBridgeEvent(config, event) {
  return bridgeRequest(config, "events", event);
}
