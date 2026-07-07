import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createSqliteBridgeStore } from "./uhura-bridge-store.mjs";
import { createSessionLiveness, hasSessionStateDir } from "./uhura-session-liveness.mjs";

export function createBridgeState() {
  return createSqliteBridgeStore({ databasePath: ":memory:" });
}

export function readBridgeServerToken(path) {
  if (typeof path !== "string" || path.length === 0) {
    return undefined;
  }
  return readFileSync(path, "utf8").trim();
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(data));
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text.length === 0 ? {} : JSON.parse(text);
}

function requireAuth(request, token) {
  if (token === undefined || token.length === 0) {
    return true;
  }

  return request.headers.authorization === `Bearer ${token}`;
}

function acceptedBridgeEvent(body) {
  if (body.type === "assistant.message") {
    return typeof body.replyToMessageId === "string"
      && body.replyToMessageId.length > 0
      && typeof body.content === "string"
      && body.content.trim().length > 0;
  }
  if (body.type === "notification.message") {
    return typeof body.content === "string" && body.content.trim().length > 0;
  }
  return true;
}

export function createBridgeHandler(options = {}) {
  const sessionLiveness = options.sessionLiveness ?? (hasSessionStateDir() ? createSessionLiveness() : undefined);
  const state = options.state ?? createSqliteBridgeStore({ databasePath: options.databasePath, sessionLiveness });
  const token = options.token;

  return async function handle(request, response) {
    try {
      if (!requireAuth(request, token)) {
        sendJson(response, 401, { ok: false, error: "Unauthorized" });
        return;
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, ...state.health() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/sessions") {
        sendJson(response, 200, { ok: true, sessions: state.listSessions() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/sessions/register") {
        const body = await readJsonBody(request);
        if (typeof body.route !== "string" || body.route.length === 0) {
          sendJson(response, 400, { ok: false, error: "route is required" });
          return;
        }
        const session = state.registerSession({
          route: body.route,
          sessionId: body.sessionId,
          alias: body.alias,
          shortId: body.shortId,
          displayName: body.displayName,
          names: body.names,
          cwd: body.cwd,
          status: body.status ?? "online",
          activityStatus: body.activityStatus,
          activityUpdatedAt: body.activityUpdatedAt,
        });
        sendJson(response, 200, { ok: true, session });
        return;
      }

      if (request.method === "POST" && url.pathname === "/sessions/poll") {
        const body = await readJsonBody(request);
        const messages = state.pollMessages(body.route);
        if (messages === undefined) {
          sendJson(response, 404, { ok: false, error: "session not registered" });
          return;
        }
        sendJson(response, 200, { ok: true, messages });
        return;
      }

      if (request.method === "POST" && url.pathname === "/messages") {
        const body = await readJsonBody(request);
        if (typeof body.prompt !== "string" || body.prompt.length === 0) {
          sendJson(response, 400, { ok: false, error: "prompt is required" });
          return;
        }
        const target = body.route ?? body.target;
        const routes = target === "all"
          ? state.availableRoutes()
          : typeof target === "string"
            ? [target]
            : [];
        if (routes.length === 0 && target !== "all") {
          sendJson(response, 400, { ok: false, error: "route or target=all is required" });
          return;
        }
        const accepted = [];
        const rejected = [];
        for (const route of routes) {
          const queued = state.queueMessage(route, body);
          if (queued === undefined) {
            rejected.push(route);
            continue;
          }
          accepted.push(queued);
        }
        if (accepted.length === 0) {
          sendJson(response, 404, {
            ok: false,
            error: "No registered Uhura session matched the requested route.",
            accepted,
            rejected,
            availableRoutes: state.availableRoutes(),
          });
          return;
        }
        sendJson(response, 200, { ok: true, accepted, rejected, availableRoutes: state.availableRoutes() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/events") {
        const body = await readJsonBody(request);
        if (typeof body.type !== "string" || body.type.length === 0) {
          sendJson(response, 400, { ok: false, error: "type is required" });
          return;
        }
        if (!acceptedBridgeEvent(body)) {
          sendJson(response, 200, { ok: true, ignored: true });
          return;
        }
        sendJson(response, 200, { ok: true, event: state.addEvent(body) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/events") {
        const since = url.searchParams.get("since");
        sendJson(response, 200, { ok: true, events: state.listEvents(since) });
        return;
      }

      sendJson(response, 404, { ok: false, error: "not found" });
    } catch (err) {
      sendJson(response, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };
}

export function createBridgeServer(options = {}) {
  const sessionLiveness = options.sessionLiveness ?? (hasSessionStateDir() ? createSessionLiveness() : undefined);
  const state = options.state ?? createSqliteBridgeStore({ databasePath: options.databasePath, sessionLiveness });
  const server = createServer(createBridgeHandler({ ...options, state }));
  server.on("close", () => state.close?.());
  return server;
}
