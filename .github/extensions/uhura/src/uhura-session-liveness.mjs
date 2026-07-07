import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export function defaultSessionStateDir() {
  return join(homedir(), ".copilot", "session-state");
}

function normalizeProcessName(name) {
  const normalized = typeof name === "string" ? name.trim().toLowerCase() : "";
  return normalized || null;
}

function getProcessInfos(pids) {
  const ids = [...new Set((pids ?? []).map((pid) => Number(pid)).filter((pid) => Number.isInteger(pid) && pid > 0))];
  const infos = new Map();
  if (ids.length === 0) {
    return infos;
  }

  if (process.platform === "win32") {
    try {
      const filter = ids.map((pid) => `ProcessId = ${pid}`).join(" OR ");
      const output = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [string]$_.ProcessId + [char]9 + $_.Name + [char]9 + [string]$_.CommandLine }`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 5000 },
      );
      for (const line of output.split(/\r?\n/)) {
        const parts = line.split("\t");
        if (parts.length < 2) {
          continue;
        }
        const pid = Number(parts[0]);
        const name = normalizeProcessName(parts[1]);
        const commandLine = parts.slice(2).join("\t") || null;
        if (Number.isInteger(pid) && name !== null) {
          infos.set(pid, { name, commandLine });
        }
      }
    } catch {
      return infos;
    }
    return infos;
  }

  for (const pid of ids) {
    try {
      const commandLine = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim() || null;
      infos.set(pid, { name: null, commandLine });
    } catch {
      infos.set(pid, { name: null, commandLine: null });
    }
  }
  return infos;
}

function isCopilotProcessName(name) {
  return name === "copilot" || name === "copilot.exe" || (name === null && process.platform !== "win32");
}

function isCopilotHelperCommandLine(commandLine) {
  const normalized = typeof commandLine === "string" ? commandLine.toLowerCase() : "";
  return normalized.includes("preloads\\extension_bootstrap.mjs") || normalized.includes("preloads/extension_bootstrap.mjs");
}

function getCommandLineSessionId(commandLine) {
  const match = /(?:^|\s)--session-id(?:=|\s+)([0-9a-f-]{36})(?:\s|$)/i.exec(typeof commandLine === "string" ? commandLine : "");
  return match ? match[1].toLowerCase() : null;
}

function isCopilotProcess(pid, sessionId, processInfos) {
  const info = processInfos.get(pid) ?? null;
  const name = normalizeProcessName(info?.name);
  if (!isCopilotProcessName(name) || isCopilotHelperCommandLine(info?.commandLine)) {
    return false;
  }
  const commandLineSessionId = getCommandLineSessionId(info?.commandLine);
  return commandLineSessionId === null || commandLineSessionId === String(sessionId).toLowerCase();
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function readSessionInfo(sessionDir) {
  try {
    const workspace = readFileSync(join(sessionDir, "workspace.yaml"), "utf8");
    const clientNameMatch = /^client_name:\s*(.+)$/m.exec(workspace);
    const cwdMatch = /^cwd:\s*(.+)$/m.exec(workspace);
    return {
      clientName: clientNameMatch === null ? null : clientNameMatch[1].trim().replace(/^['"]|['"]$/g, ""),
      cwd: cwdMatch === null ? null : cwdMatch[1].trim().replace(/^['"]|['"]$/g, ""),
    };
  } catch {
    return { clientName: null, cwd: null };
  }
}

export function createSessionLiveness(options = {}) {
  const sessionStateDir = options.sessionStateDir ?? defaultSessionStateDir();
  const ttlMs = Math.min(Math.max(Number(options.ttlMs ?? 1000), 0), 30000);
  const readProcessInfos = typeof options.getProcessInfos === "function" ? options.getProcessInfos : getProcessInfos;
  let cachedAt = 0;
  let cachedSessionIds = new Set();

  function computeLiveSessionIds(sessionIds) {
    const scopedSessionIds = Array.isArray(sessionIds) ? [...new Set(sessionIds.filter((sessionId) => typeof sessionId === "string" && sessionId.length > 0))] : undefined;
    const names = scopedSessionIds ?? (() => {
      try {
        return readdirSync(sessionStateDir);
      } catch {
        return [];
      }
    })();
    if (names.length === 0) {
      return new Set();
    }
    const candidates = [];
    for (const sessionId of names) {
      const sessionDir = join(sessionStateDir, sessionId);
      let files;
      try {
        files = readdirSync(sessionDir);
      } catch {
        continue;
      }
      for (const file of files) {
        const match = /^inuse\.(\d+)\.lock$/.exec(file);
        if (match === null) {
          continue;
        }
        const pid = Number(match[1]);
        if (isPidAlive(pid)) {
          candidates.push({ sessionId, sessionDir, pid });
        }
      }
    }
    const processInfos = readProcessInfos(candidates.map((candidate) => candidate.pid));
    const accepted = new Set();
    for (const candidate of candidates) {
      if (accepted.has(candidate.sessionId)) {
        continue;
      }
      if (!isCopilotProcess(candidate.pid, candidate.sessionId, processInfos)) {
        continue;
      }
      const info = readSessionInfo(candidate.sessionDir);
      if (info.clientName !== "github/cli") {
        continue;
      }
      accepted.add(candidate.sessionId);
    }
    return accepted;
  }

  function refresh() {
    const now = Date.now();
    if (now - cachedAt <= ttlMs) {
      return cachedSessionIds;
    }
    cachedAt = now;
    cachedSessionIds = computeLiveSessionIds();
    return cachedSessionIds;
  }

  function sessionLiveness({ sessionId }) {
    if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId === "unknown") {
      return false;
    }
    return refresh().has(sessionId);
  }

  sessionLiveness.liveSessionIds = (sessionIds) => computeLiveSessionIds(sessionIds);
  return sessionLiveness;
}

export function listLiveInteractiveSessions(options = {}) {
  const sessionStateDir = options.sessionStateDir ?? defaultSessionStateDir();
  const isLive = createSessionLiveness({ ...options, ttlMs: 0 });
  let names;
  try {
    names = readdirSync(sessionStateDir);
  } catch {
    return [];
  }
  return names
    .filter((sessionId) => isLive({ sessionId }))
    .map((sessionId) => {
      const info = readSessionInfo(join(sessionStateDir, sessionId));
      return { sessionId, cwd: info.cwd ?? undefined, dir: info.cwd === null ? "" : basename(info.cwd) };
    });
}

export function hasSessionStateDir() {
  return existsSync(defaultSessionStateDir());
}
