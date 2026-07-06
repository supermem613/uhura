import { joinSession } from "@github/copilot-sdk/extension";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { authenticateWithTeams, readAuthStatus } from "./uhura-auth.mjs";
import { ensureBridgeRunning, formatBridgeInjectedPrompt, pollBridgeMessages, postBridgeEvent, registerBridgeSession } from "./uhura-bridge-client.mjs";
import {
  buildConfigExample,
  createGraphClient,
  createSessionIdentity,
  describeConfig,
  formatOutboundMessage,
  loadConfig,
  parseRoutedMessage,
  readState,
  updateConfigTarget,
  updateState,
} from "./uhura-core.mjs";

export async function registerUhuraExtension(options = {}) {
  if (options.source === "project" && existsSync(join(homedir(), ".copilot", "extensions", "uhura", "extension.mjs"))) {
    await joinSession({
      tools: [],
      hooks: {
        onSessionStart: async () => ({
          additionalContext: "Uhura user extension is installed, so the project extension skipped duplicate tool registration.",
        }),
      },
    });
    return;
  }

  const state = {
    config: loadConfig(),
    identity: createSessionIdentity(),
    poller: undefined,
    bridgePoller: undefined,
    bridgeBusy: false,
    bridgeReplyQueue: [],
    activityStatus: "busy",
    activityUpdatedAt: new Date().toISOString(),
    polling: false,
  };
  let session;

  function markActivity(activityStatus) {
    if (state.activityStatus === activityStatus) {
      return;
    }
    state.activityStatus = activityStatus;
    state.activityUpdatedAt = new Date().toISOString();
  }

  function refreshIdentity(input, invocation, metadata = {}) {
    state.identity = createSessionIdentity({
      previous: state.identity,
      configuredAlias: state.config.session?.alias,
      sessionId: invocation?.sessionId ?? session?.sessionId,
      sessionName: metadata.sessionName,
      workingDirectory: input?.workingDirectory,
    });
    return state.identity;
  }

  async function refreshIdentityFromSessionMetadata() {
    if (typeof session?.rpc?.metadata?.snapshot !== "function") {
      return;
    }
    try {
      const metadata = await session.rpc.metadata.snapshot();
      refreshIdentity({ workingDirectory: metadata.workingDirectory }, undefined, {
        sessionName: metadata.initialName ?? metadata.workspace?.name ?? metadata.summary ?? metadata.remoteMetadata?.name ?? metadata.remoteMetadata?.summary,
      });
    } catch (err) {
      await session.log(`Uhura could not read Copilot session metadata: ${err instanceof Error ? err.message : String(err)}`, { level: "warning" });
    }
  }

  async function sendToTeams(message, invocation, input) {
    const identity = refreshIdentity(input, invocation);
    const client = createGraphClient(state.config);
    const result = await client.sendMessage(formatOutboundMessage({ message, identity }));
    return JSON.stringify({
      ok: true,
      target: state.config.target?.type,
      sessionRoute: identity.route,
      messageId: result.id,
    });
  }

  async function checkTeams(invocation, input, options = {}) {
    const identity = refreshIdentity(input, invocation);
    const client = createGraphClient(state.config);
    const remoteState = readState();
    const known = remoteState.sessions?.[identity.route]?.seenMessageIds ?? [];
    const messages = await client.listMessages();
    const routed = [];
    const seen = new Set(known);

    for (const message of messages) {
      if (seen.has(message.id)) {
        continue;
      }

      const route = parseRoutedMessage({
        html: message.body?.content,
        handle: state.config.routing?.handle ?? "uhura",
        identity,
        allowBroadcast: state.config.routing?.allowBroadcast !== false,
      });
      if (route !== undefined) {
        routed.push({ messageId: message.id, prompt: route.prompt, from: message.from });
      }
      seen.add(message.id);
    }

    updateState((draft) => {
      draft.sessions ??= {};
      draft.sessions[identity.route] = {
        seenMessageIds: [...seen].slice(-200),
        lastCheckedAt: new Date().toISOString(),
      };
    });

    if (options.inject !== false) {
      for (const item of routed) {
        await session.send({
          prompt: `Teams message routed through Uhura from ${item.from ?? "Teams"}:\n\n${item.prompt}`,
        });
      }
    }

    return JSON.stringify({
      ok: true,
      sessionRoute: identity.route,
      received: routed.map((item) => ({
        messageId: item.messageId,
        from: item.from,
        prompt: item.prompt,
      })),
    });
  }

  async function listTargets(args) {
    try {
      const client = createGraphClient(state.config);
      const targets = await client.listTargets(Number(args.top ?? 20));
      return JSON.stringify({ ok: true, targets });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        auth: readAuthStatus(),
      });
    }
  }

  async function setTarget(args) {
    const target = args.type === "channel"
      ? { type: "channel", teamId: String(args.teamId), channelId: String(args.channelId) }
      : { type: "chat", chatId: String(args.chatId) };
    updateConfigTarget(target);
    state.config = loadConfig();
    return JSON.stringify({
      ok: true,
      config: describeConfig(state.config),
    });
  }

  function startPolling() {
    if (state.poller !== undefined || state.config.polling?.enabled !== true || !state.config.valid) {
      return;
    }
    const intervalMs = Math.min(Math.max(Number(state.config.polling?.intervalMs ?? 15000), 5000), 60000);
    state.poller = setInterval(() => {
      if (state.polling) {
        return;
      }
      state.polling = true;
      checkTeams(undefined, undefined, { inject: true })
        .catch((err) => session.log(`Uhura polling failed: ${err instanceof Error ? err.message : String(err)}`, { level: "warning" }))
        .finally(() => {
          state.polling = false;
        });
    }, intervalMs);
    state.poller.unref?.();
  }

  async function registerWithBridge() {
    if (state.config.bridge?.enabled !== true) {
      return false;
    }
    if (state.identity.shortId === "unknown") {
      return false;
    }
    const bridgeStatus = await ensureBridgeRunning(state.config.bridge);
    if (bridgeStatus !== "running") {
      return false;
    }
    const identity = state.identity;
    await registerBridgeSession(state.config.bridge, {
      route: identity.route,
      sessionId: identity.sessionId,
      alias: identity.alias,
      shortId: identity.shortId,
      displayName: identity.displayName,
      names: identity.names,
      cwd: identity.workingDirectory,
      status: "online",
      activityStatus: state.activityStatus,
      activityUpdatedAt: state.activityUpdatedAt,
    });
    return true;
  }

  function startBridgePolling() {
    if (state.bridgePoller !== undefined || state.config.bridge?.enabled !== true) {
      return;
    }
    ensureBridgeRunning(state.config.bridge)
      .then((bridgeStatus) => {
        if (bridgeStatus === "started") {
          return session.log("Uhura bridge autostarted. Session registration will retry shortly.", { level: "warning" });
        }
        return undefined;
      })
      .catch((err) => session.log(`Uhura bridge autostart failed: ${err instanceof Error ? err.message : String(err)}`, { level: "warning" }));
    const intervalMs = Math.min(Math.max(Number(state.config.bridge.intervalMs ?? 2000), 1000), 30000);
    state.bridgePoller = setInterval(() => {
      if (state.bridgeBusy) {
        return;
      }
      state.bridgeBusy = true;
      (async () => {
        const registered = await registerWithBridge();
        if (!registered) {
          return;
        }
        const result = await pollBridgeMessages(state.config.bridge, state.identity.route);
        for (const message of result.messages ?? []) {
          markActivity("busy");
          const pendingReply = {
            messageId: message.id,
            from: message.from ?? "Scout",
          };
          state.bridgeReplyQueue.push(pendingReply);
          state.bridgeReplyQueue = state.bridgeReplyQueue.slice(-50);
          try {
            await session.send({
              prompt: formatBridgeInjectedPrompt(message),
            });
          } catch (err) {
            state.bridgeReplyQueue = state.bridgeReplyQueue.filter((item) => item !== pendingReply);
            throw err;
          }
          await postBridgeEvent(state.config.bridge, {
            route: state.identity.route,
            type: "message.injected",
            messageId: message.id,
            from: message.from ?? "Scout",
          });
        }
      })()
        .catch((err) => session.log(`Uhura bridge polling failed: ${err instanceof Error ? err.message : String(err)}`, { level: "warning" }))
        .finally(() => {
          state.bridgeBusy = false;
        });
    }, intervalMs);
    state.bridgePoller.unref?.();
  }

  session = await joinSession({
    tools: [
      {
        name: "uhura_status",
        description: "Show Uhura status and this Copilot CLI session alias and route.",
        parameters: {
          type: "object",
          properties: {},
        },
        handler: async (_args, invocation) => {
          markActivity("busy");
          const identity = refreshIdentity(undefined, invocation);
          return JSON.stringify({
            ok: true,
            sessionAlias: identity.alias,
            sessionRoute: identity.route,
            displayName: identity.displayName,
            activityStatus: state.activityStatus,
            isBusy: state.activityStatus === "busy",
            isIdle: state.activityStatus === "idle",
            isWaiting: state.activityStatus === "waiting",
            activityUpdatedAt: state.activityUpdatedAt,
            config: describeConfig(state.config),
            auth: readAuthStatus(),
            pollingEnabled: state.config.polling?.enabled === true,
            bridgeEnabled: state.config.bridge?.enabled === true,
          });
        },
      },
      {
        name: "uhura_send",
        description: "Send a Teams message through Uhura with this Copilot CLI session visibly identified.",
        parameters: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Message to send into the configured Teams chat or channel.",
              minLength: 1,
            },
          },
          required: ["message"],
        },
        handler: async (args, invocation) => sendToTeams(String(args.message), invocation),
      },
      {
        name: "uhura_notify",
        description: "Send an explicit local Uhura notification event for Scout.",
        parameters: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Notification text for Scout.",
              minLength: 1,
            },
          },
          required: ["message"],
        },
        handler: async (args, invocation) => {
          markActivity("busy");
          const identity = refreshIdentity(undefined, invocation);
          if (state.config.bridge?.enabled !== true) {
            return JSON.stringify({ ok: false, error: "Uhura bridge is not enabled." });
          }
          const result = await postBridgeEvent(state.config.bridge, {
            route: identity.route,
            type: "notification.message",
            content: String(args.message),
            messageId: `notification-${Date.now()}`,
          });
          return JSON.stringify({ ok: true, event: result.event });
        },
      },
      {
        name: "uhura_check",
        description: "Poll Teams once and inject any messages routed to this Copilot CLI session.",
        parameters: {
          type: "object",
          properties: {
            inject: {
              type: "boolean",
              description: "When true, routed Teams messages are sent into this Copilot session.",
              default: true,
            },
          },
        },
        handler: async (args, invocation) => {
          try {
            return await checkTeams(invocation, undefined, { inject: args.inject !== false });
          } catch (err) {
            return JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              auth: readAuthStatus(),
            });
          }
        },
      },
      {
        name: "uhura_targets",
        description: "List Teams chat targets visible to Uhura's integrated Graph token.",
        parameters: {
          type: "object",
          properties: {
            top: {
              type: "integer",
              description: "Maximum chat targets to return.",
              minimum: 1,
              maximum: 50,
              default: 20,
            },
          },
        },
        handler: async (args) => listTargets(args),
      },
      {
        name: "uhura_set_target",
        description: "Set the Teams chat or channel target in Uhura config.",
        parameters: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["chat", "channel"],
              description: "Target type.",
            },
            chatId: {
              type: "string",
              description: "Teams chat id when type is chat.",
            },
            teamId: {
              type: "string",
              description: "Team id when type is channel.",
            },
            channelId: {
              type: "string",
              description: "Channel id when type is channel.",
            },
          },
          required: ["type"],
        },
        handler: async (args) => setTarget(args),
      },
      {
        name: "uhura_auth_status",
        description: "Show Uhura integrated Teams Graph token status.",
        parameters: {
          type: "object",
          properties: {},
        },
        handler: async () => JSON.stringify({ ok: true, auth: readAuthStatus() }),
      },
      {
        name: "uhura_auth",
        description: "Open Teams with Playwright and capture the delegated Graph token Uhura needs.",
        parameters: {
          type: "object",
          properties: {
            forceVisible: {
              type: "boolean",
              description: "Open visible Edge even if a headless token probe might work.",
              default: true,
            },
          },
        },
        handler: async (args) => {
          const auth = await authenticateWithTeams({
            forceVisible: args.forceVisible !== false,
            log: (message) => session.log(`Uhura auth: ${message}`, { ephemeral: true }),
          });
          state.config = loadConfig();
          return JSON.stringify({ ok: true, auth });
        },
      },
      {
        name: "uhura_config_example",
        description: "Return a redacted Uhura Teams bridge configuration template.",
        parameters: {
          type: "object",
          properties: {},
        },
        handler: async () => JSON.stringify({ ok: true, config: buildConfigExample() }),
      },
    ],
    hooks: {
      onSessionStart: async (input, invocation) => {
        const identity = refreshIdentity(input, invocation);
        if (session !== undefined) {
          startPolling();
          await registerWithBridge().catch((err) => session.log(`Uhura bridge registration failed: ${err instanceof Error ? err.message : String(err)}`, { level: "warning" }));
          startBridgePolling();
        }
        return {
          additionalContext: `Uhura alias for this session: ${identity.alias}. Exact route: ${identity.route}. Use uhura_send only for explicit Teams Graph sends and uhura_check only for Teams polling.`,
        };
      },
      onUserPromptSubmitted: async (input, invocation) => {
        markActivity("busy");
        refreshIdentity(input, invocation);
      },
    },
  });

  refreshIdentity();
  await refreshIdentityFromSessionMetadata();

  if (!state.config.valid) {
    await session.log(`Uhura loaded without usable Teams config: ${state.config.error}`, { level: "warning" });
  } else {
    startPolling();
    await registerWithBridge().catch((err) => session.log(`Uhura bridge registration failed: ${err instanceof Error ? err.message : String(err)}`, { level: "warning" }));
    startBridgePolling();
    await session.log(`Uhura loaded. Alias: ${state.identity.alias}. Route: ${state.identity.route}`);
  }

  if (typeof session.on === "function") {
    session.on("assistant.message", (event) => {
      if (state.config.bridge?.enabled !== true) {
        return;
      }
      markActivity("busy");
      const content = typeof event.data?.content === "string" ? event.data.content : "";
      if (content.trim().length === 0 || state.bridgeReplyQueue.length === 0) {
        return;
      }
      const pendingReply = state.bridgeReplyQueue.shift();
      postBridgeEvent(state.config.bridge, {
        route: state.identity.route,
        type: "assistant.message",
        content,
        messageId: event.data?.messageId,
        replyToMessageId: pendingReply.messageId,
        from: pendingReply.from,
      }).catch((err) => session.log(`Uhura bridge event post failed: ${err instanceof Error ? err.message : String(err)}`, { level: "warning" }));
    });
    session.on("session.idle", () => {
      markActivity("idle");
      registerWithBridge().catch((err) => session.log(`Uhura idle state update failed: ${err instanceof Error ? err.message : String(err)}`, { level: "warning" }));
    });
  }
}
