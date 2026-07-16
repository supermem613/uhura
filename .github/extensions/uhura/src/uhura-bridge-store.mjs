import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { slug, uniqueStrings } from "./uhura-core.mjs";

export function defaultBridgeDataDir() {
  return join(homedir(), ".uhura");
}

export function defaultBridgeDatabasePath() {
  return join(defaultBridgeDataDir(), "bridge.sqlite");
}

export function defaultBridgeDiscoveryPath() {
  return join(defaultBridgeDataDir(), "bridge.json");
}

function nowIso() {
  return new Date().toISOString();
}

function ensureParent(path) {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

function parseEvent(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    ...JSON.parse(row.data_json),
  };
}

function parseMessage(row) {
  return {
    id: row.id,
    from: row.from_name,
    prompt: row.prompt,
    createdAt: row.created_at,
    delivered: row.delivered_at !== null,
    deliveredAt: row.delivered_at ?? undefined,
  };
}

function publicSession(row) {
  const displayName = row.display_name ?? undefined;
  const shortId = row.short_id;
  const activityStatus = row.activity_status ?? "unknown";
  const alias = sessionAlias({
    alias: row.alias,
    cwd: row.cwd,
    displayName,
    route: row.route,
    shortId,
  });
  return {
    route: row.route,
    sessionId: row.session_id,
    alias,
    shortId,
    displayName,
    names: uniqueStrings([displayName, alias, shortId, row.route]),
    cwd: row.cwd ?? undefined,
    status: row.status,
    activityStatus,
    isBusy: activityStatus === "unknown" ? null : activityStatus === "busy",
    isIdle: activityStatus === "unknown" ? null : activityStatus === "idle",
    isWaiting: activityStatus === "unknown" ? null : activityStatus === "waiting",
    activityUpdatedAt: row.activity_updated_at ?? undefined,
    lastSeenAt: row.last_seen_at,
    pendingMessages: row.pending_messages,
  };
}

function isVisibleSession(row, sessionLiveness) {
  if (typeof sessionLiveness !== "function") {
    return true;
  }
  return sessionLiveness({ route: row.route, sessionId: row.session_id, cwd: row.cwd }) === true;
}

function visibleSessionRows(rows, sessionLiveness) {
  if (typeof sessionLiveness !== "function") {
    return rows;
  }
  if (typeof sessionLiveness.liveSessionIds === "function") {
    const visible = sessionLiveness.liveSessionIds(rows.map((row) => row.session_id));
    return rows.filter((row) => visible.has(row.session_id));
  }
  return rows.filter((row) => isVisibleSession(row, sessionLiveness));
}

function routeAlias(route, shortId) {
  if (typeof route !== "string" || typeof shortId !== "string" || shortId === "unknown") {
    return undefined;
  }
  const suffix = `-${shortId}`;
  if (!route.endsWith(suffix)) {
    return undefined;
  }
  const alias = route.slice(0, -suffix.length);
  return alias.length > 0 ? alias : undefined;
}

function cwdAlias(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    return undefined;
  }
  return slug(basename(cwd));
}

function sessionAlias(session) {
  if (typeof session.displayName === "string" && session.displayName.length > 0) {
    return slug(session.displayName);
  }
  return cwdAlias(session.cwd) ?? slug(routeAlias(session.route, session.shortId) ?? session.alias ?? "session");
}

function normalizeRegisteredSession(session) {
  const displayName = typeof session.displayName === "string" && session.displayName.trim().length > 0
    ? session.displayName.trim()
    : undefined;
  const shortId = session.shortId ?? "unknown";
  const alias = sessionAlias({ ...session, displayName, shortId });
  return {
    ...session,
    alias,
    shortId,
    displayName,
    names: uniqueStrings([displayName, alias, shortId, session.route]),
    activityStatus: normalizeActivityStatus(session.activityStatus),
    activityUpdatedAt: typeof session.activityUpdatedAt === "string" && session.activityUpdatedAt.length > 0
      ? session.activityUpdatedAt
      : undefined,
  };
}

function normalizeActivityStatus(value) {
  if (value === "active" || value === "busy") {
    return "busy";
  }
  if (value === "idle" || value === "waiting") {
    return value;
  }
  return "unknown";
}

function sessionLifecycleFields(session) {
  return {
    route: session.route,
    sessionId: session.sessionId,
    alias: session.alias,
    shortId: session.shortId,
    displayName: session.displayName,
    names: session.names,
    cwd: session.cwd,
    status: session.status,
  };
}

function sessionLifecycleChanged(before, after) {
  if (before === undefined) {
    return true;
  }
  return JSON.stringify(sessionLifecycleFields(before)) !== JSON.stringify(sessionLifecycleFields(after));
}

export function createSqliteBridgeStore(options = {}) {
  const databasePath = options.databasePath ?? defaultBridgeDatabasePath();
  const sessionLiveness = options.sessionLiveness;
  if (databasePath !== ":memory:") {
    ensureParent(databasePath);
  }

  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS sessions (
      route TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      short_id TEXT NOT NULL,
      display_name TEXT,
      names_json TEXT,
      cwd TEXT,
      status TEXT NOT NULL,
      activity_status TEXT NOT NULL DEFAULT 'unknown',
      activity_updated_at TEXT,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      route TEXT NOT NULL,
      from_name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      UNIQUE(route, id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_route_delivery
      ON messages(route, delivered_at, created_at);

    CREATE TABLE IF NOT EXISTS events (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      route TEXT,
      type TEXT NOT NULL,
      data_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_created_at
      ON events(created_at);
  `);
  const sessionColumns = new Set(database.prepare("PRAGMA table_info(sessions)").all().map((column) => column.name));
  if (!sessionColumns.has("display_name")) {
    database.exec("ALTER TABLE sessions ADD COLUMN display_name TEXT");
  }
  if (!sessionColumns.has("names_json")) {
    database.exec("ALTER TABLE sessions ADD COLUMN names_json TEXT");
  }
  if (!sessionColumns.has("activity_status")) {
    database.exec("ALTER TABLE sessions ADD COLUMN activity_status TEXT NOT NULL DEFAULT 'unknown'");
  }
  if (!sessionColumns.has("activity_updated_at")) {
    database.exec("ALTER TABLE sessions ADD COLUMN activity_updated_at TEXT");
  }

  function addEvent(event) {
    const next = {
      id: randomUUID(),
      createdAt: nowIso(),
      ...event,
    };
    database.prepare(`
      INSERT INTO events (id, created_at, route, type, data_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(next.id, next.createdAt, next.route ?? null, next.type, JSON.stringify(event));
    database.prepare(`
      DELETE FROM events
      WHERE row_id NOT IN (
        SELECT row_id FROM events ORDER BY created_at DESC, row_id DESC LIMIT 500
      )
    `).run();
    return next;
  }

  function listSessionRows() {
    return database.prepare(`
      SELECT
        s.route,
        s.session_id,
        s.alias,
        s.short_id,
        s.display_name,
        s.names_json,
        s.cwd,
        s.status,
        s.activity_status,
        s.activity_updated_at,
        s.last_seen_at,
        COALESCE(p.pending_messages, 0) AS pending_messages
      FROM sessions s
      LEFT JOIN (
        SELECT route, COUNT(*) AS pending_messages
        FROM messages
        WHERE delivered_at IS NULL
        GROUP BY route
      ) p ON p.route = s.route
      ORDER BY s.last_seen_at DESC, s.route ASC
    `).all();
  }

  function listSessions() {
    return visibleSessionRows(listSessionRows(), sessionLiveness).map(publicSession);
  }

  function getSession(route) {
    return database.prepare(`
      SELECT
        s.route,
        s.session_id,
        s.alias,
        s.short_id,
        s.display_name,
        s.names_json,
        s.cwd,
        s.status,
        s.activity_status,
        s.activity_updated_at,
        s.last_seen_at,
        COALESCE(p.pending_messages, 0) AS pending_messages
      FROM sessions s
      LEFT JOIN (
        SELECT route, COUNT(*) AS pending_messages
        FROM messages
        WHERE delivered_at IS NULL
        GROUP BY route
      ) p ON p.route = s.route
      WHERE s.route = ?
    `).get(route);
  }

  return {
    databasePath,
    health() {
      const sessions = database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count;
      const events = database.prepare("SELECT COUNT(*) AS count FROM events").get().count;
      return { sessions, events };
    },
    listSessions,
    availableRoutes() {
      return listSessions().map((session) => session.route);
    },
    registerSession(session) {
      const normalized = normalizeRegisteredSession(session);
      const lastSeenAt = nowIso();
      const beforeRow = getSession(normalized.route);
      const before = beforeRow === undefined ? undefined : publicSession(beforeRow);
      database.prepare("DELETE FROM sessions WHERE session_id = ? AND route != ?").run(normalized.sessionId ?? "", normalized.route);
      database.prepare(`
        INSERT INTO sessions (route, session_id, alias, short_id, display_name, names_json, cwd, status, activity_status, activity_updated_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(route) DO UPDATE SET
          session_id = excluded.session_id,
          alias = excluded.alias,
          short_id = excluded.short_id,
          display_name = excluded.display_name,
          names_json = excluded.names_json,
          cwd = excluded.cwd,
          status = excluded.status,
          activity_status = excluded.activity_status,
          activity_updated_at = excluded.activity_updated_at,
          last_seen_at = excluded.last_seen_at
      `).run(
        normalized.route,
        normalized.sessionId ?? "",
        normalized.alias,
        normalized.shortId,
        normalized.displayName ?? null,
        JSON.stringify(normalized.names),
        normalized.cwd ?? null,
        normalized.status ?? "online",
        normalized.activityStatus,
        normalized.activityUpdatedAt ?? null,
        lastSeenAt,
      );
      const registered = publicSession(getSession(normalized.route));
      if (sessionLifecycleChanged(before, registered)) {
        addEvent({ route: normalized.route, type: "session.registered", session: registered });
      }
      return registered;
    },
    pollMessages(route) {
      const session = getSession(route);
      if (session === undefined) {
        return undefined;
      }
      database.prepare("UPDATE sessions SET last_seen_at = ? WHERE route = ?").run(nowIso(), route);
      const rows = database.prepare(`
        SELECT row_id, id, from_name, prompt, created_at, delivered_at
        FROM messages
        WHERE route = ? AND delivered_at IS NULL
        ORDER BY created_at ASC, row_id ASC
      `).all(route);
      const deliveredAt = nowIso();
      const update = database.prepare("UPDATE messages SET delivered_at = ? WHERE row_id = ?");
      for (const row of rows) {
        update.run(deliveredAt, row.row_id);
        row.delivered_at = deliveredAt;
      }
      return rows.map(parseMessage);
    },
    queueMessage(route, body) {
      const session = getSession(route);
      if (session === undefined || !isVisibleSession(session, sessionLiveness)) {
        return undefined;
      }
      const message = {
        id: body.id ?? randomUUID(),
        from: body.from ?? "Scout",
        prompt: body.prompt,
        createdAt: nowIso(),
      };
      database.prepare(`
        INSERT INTO messages (id, route, from_name, prompt, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(message.id, route, message.from, message.prompt, message.createdAt);
      addEvent({ route, type: "message.queued", message: { id: message.id, from: message.from } });
      return { route, id: message.id };
    },
    addEvent,
    listEvents(since) {
      const rows = since === null
        ? database.prepare("SELECT id, created_at, data_json FROM events ORDER BY created_at ASC, row_id ASC").all()
        : database.prepare("SELECT id, created_at, data_json FROM events WHERE id > ? OR created_at > ? ORDER BY created_at ASC, row_id ASC").all(since, since);
      return rows.map(parseEvent);
    },
    close() {
      database.close();
    },
  };
}

export function buildBridgeDiscovery({ host, port, databasePath }) {
  const baseUrl = `http://${host}:${port}`;
  return {
    name: "uhura",
    baseUrl,
    healthUrl: `${baseUrl}/health`,
    sessionsUrl: `${baseUrl}/sessions`,
    messagesUrl: `${baseUrl}/messages`,
    eventsUrl: `${baseUrl}/events`,
    databasePath,
    pid: process.pid,
    updatedAt: nowIso(),
  };
}

export function writeBridgeDiscovery(path, discovery) {
  ensureParent(path);
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(discovery, null, 2), "utf8");
  renameSync(tempPath, path);
}
