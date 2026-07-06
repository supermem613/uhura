# uhura

Copilot CLI extension for bidirectional Teams communication across multiple local Copilot CLI sessions.

Uhura posts through Microsoft Graph into one Teams chat or channel and polls the same target for routed replies. Each outgoing message is visibly prefixed with the current Copilot session label, and incoming Teams messages are injected only when they are addressed to that session.

## Message routing

Send a message from Teams to one session:

```text
@uhura <session-route> review the failing test
```

Send to every running Uhura-enabled session:

```text
@uhura all summarize your current status
```

The session route is shown by the `uhura_status` Copilot extension tool and in every outgoing Teams message. When Copilot CLI exposes a friendly session name, Uhura uses it as the route prefix, for example `fix-scout-bridge-6c33d4e1`; Scout can still address the session by the full route, short id, cwd/repo name, or the friendly session name.

## Configuration

Create `%USERPROFILE%\.copilot\uhura\config.json`:

```json
{
  "graph": {
    "authMode": "teams"
  },
  "target": {
    "type": "chat",
    "chatId": "19:..."
  },
  "polling": {
    "enabled": true,
    "intervalMs": 15000
  },
  "routing": {
    "handle": "uhura",
    "allowBroadcast": true
  },
  "session": {
    "alias": "captain"
  },
  "bridge": {
    "enabled": true,
    "url": "http://127.0.0.1:47871",
    "intervalMs": 2000,
    "autoStart": true
  }
}
```

For a Teams channel target, use:

```json
{
  "channelRead": {
    "mode": "rsc",
    "tenantId": "72f988bf-86f1-41af-91ab-2d7cd011db47",
    "clientId": "<entra-app-client-id>",
    "clientSecretFile": "C:\\Users\\marcusm\\.copilot\\uhura\\rsc-client-secret.txt"
  },
  "target": {
    "type": "channel",
    "teamId": "...",
    "channelId": "..."
  }
}
```

Run `uhura_auth` once to open Teams with Playwright and capture the delegated Microsoft Graph token directly into `C:\Users\marcusm\.copilot\uhura\auth.json`. Use `uhura_auth_status` to check token state.

The captured delegated token needs permissions that match the target:

| Capability | Chat target | Channel target |
| --- | --- | --- |
| Send | `ChatMessage.Send` | `ChannelMessage.Send` |
| Read | `Chat.Read` or `Chat.ReadBasic` plus message access allowed by tenant policy | App-only RSC `ChannelMessage.Read.Group`, or delegated `ChannelMessage.Read.All` |

Channel reads are API-only. Uhura does not use a browser fallback for normal channel polling. The recommended no-tenant-wide-admin path is a Teams app installed in the target team with resource-specific consent for `ChannelMessage.Read.Group`, backed by an Entra app client credential configured in `channelRead`.

Instead of integrated Teams auth, advanced users can set an explicit token file:

```json
{
  "graph": {
    "accessTokenFile": "C:\\Users\\marcusm\\.copilot\\uhura\\graph-token.txt"
  }
}
```

Or a token command:

```json
{
  "graph": {
    "accessTokenCommand": {
      "tool": "mg-api",
      "args": ["token", "--resource", "https://graph.microsoft.com"]
    }
  }
}
```

The command must print either the raw token or JSON with `accessToken`, `token`, or `data.accessToken`.

## Copilot tools

| Tool | Purpose |
| --- | --- |
| `uhura_status` | Show session alias, route, activity state, config state, and polling state |
| `uhura_send` | Send a Teams message with the Uhura session prefix |
| `uhura_notify` | Send an explicit local notification event for Scout |
| `uhura_check` | Poll Teams once and inject any messages routed to this session |
| `uhura_targets` | List Teams chats visible to Uhura's integrated Graph token |
| `uhura_set_target` | Save a chat or channel target to Uhura config |
| `uhura_auth` | Open Teams with Playwright and capture Uhura's delegated Graph token |
| `uhura_auth_status` | Show integrated Teams Graph token state |
| `uhura_config_example` | Return a redacted config template |

## Scout / Clawpilot local bridge

Uhura can also expose visible Copilot CLI sessions to a locally running Scout or Clawpilot process without using Teams Graph channel reads.

Start the local bridge:

```powershell
npm run bridge
```

When `bridge.enabled` is true, the Uhura extension also auto-starts the local bridge unless `bridge.autoStart` is set to `false`. The standalone command is useful for debugging or for running the bridge before Copilot starts.

If the extension host cannot find Node on `PATH`, set `bridge.nodePath` to the full `node.exe` path.

Enable bridge registration in `%USERPROFILE%\.copilot\uhura\config.json`:

```json
{
  "bridge": {
    "enabled": true,
    "url": "http://127.0.0.1:47871",
    "intervalMs": 2000,
    "autoStart": true,
    "databasePath": "C:\\Users\\marcusm\\.copilot\\uhura\\bridge.sqlite",
    "discoveryFile": "C:\\Users\\marcusm\\.copilot\\uhura\\bridge.json"
  }
}
```

Scout can call:

| Discovery | Purpose |
| --- | --- |
| `%USERPROFILE%\.copilot\uhura\bridge.json` | Well-known local file written by the running bridge with `baseUrl`, endpoint URLs, PID, and database path |

| Endpoint | Purpose |
| --- | --- |
| `GET /sessions` | List visible Uhura-enabled Copilot CLI sessions, including `activityStatus`, `isBusy`, `isIdle`, `isWaiting`, and `activityUpdatedAt` |
| `POST /messages` | Queue a message for one session or `target: "all"` |
| `GET /events` | Read Scout replies, explicit notifications, and bridge events |

For local Scout bridge round trips, the target Copilot session should answer normally. Uhura writes only the reply to a Scout-injected message to `/events`; routine assistant progress is ignored. Use `uhura_notify` for deliberate local notifications and `uhura_send` only for explicit Teams Graph sends.

On every Scout restart, read `%USERPROFILE%\.copilot\uhura\bridge.json` if it exists and probe `healthUrl`. If the file is stale or missing, probe the canonical default `http://127.0.0.1:47871/health`. Once healthy, call `/sessions` for current routes. Sessions re-register by heartbeat after bridge or Copilot restarts, while queued messages and events are persisted in SQLite.

### Scout MCP setup

Add Uhura to Scout as a command MCP server:

```text
node C:\Users\marcusm\repos\uhura\scripts\uhura-mcp.mjs
```

The MCP adapter exposes:

| Tool | Purpose |
| --- | --- |
| `uhura_discover` | Discover and health-check the local bridge |
| `uhura_sessions` | List or resolve Copilot CLI sessions |
| `uhura_send` | Send to one route, friendly session name, short id, cwd name, alias, or `all` |
| `uhura_events` | Read assistant reply and notification events from the bridge |
| `uhura_ask` | Send to one session and wait for its next assistant reply event |

### Local CLI

Use the `uhura` CLI to exercise the same MCP handlers without going through Scout:

```powershell
node scripts\uhura.mjs schema --summary
node scripts\uhura.mjs tools
node scripts\uhura.mjs sessions uhura-create
node scripts\uhura.mjs send --to uhura-create --prompt "SCOUT-PING"
node scripts\uhura.mjs events --route uhura-create-6c33d4e1 --type assistant.message
node scripts\uhura.mjs call uhura_sessions --args-json "{\"target\":\"uhura-create\"}"
```

The package also declares a `uhura` bin, so a linked checkout can run the same commands as `uhura sessions`, `uhura send`, and `uhura call`.

Example Scout-to-Copilot message:

```json
POST http://127.0.0.1:47871/messages
{
  "route": "captain-6c33d4e1",
  "from": "Scout",
  "prompt": "summarize current status"
}
```

## Install as a user extension

Run:

```powershell
node scripts\install-extension-shim.mjs
```

Then reload Copilot CLI extensions.

## Development

```powershell
npm test
```

## License

MIT
