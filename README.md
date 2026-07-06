# uhura

Uhura connects visible GitHub Copilot CLI sessions to local automation. Its primary path is a localhost bridge that Scout or another local client can use to discover sessions, send prompts, and read deliberate replies or notifications.

## What ships

| Surface | Purpose |
| --- | --- |
| Copilot CLI extension | Registers the current Copilot session with the local bridge, exposes Uhura tools, injects queued bridge messages, and mirrors replies to Scout |
| Local bridge | Stores sessions, queued prompts, and events in SQLite and writes a discovery file for local clients |
| Scout MCP adapter | Exposes bridge operations as MCP tools for Scout or Clawpilot |
| Local `uhura` CLI | Exercises the same MCP handlers from a terminal |

## Install as a user extension

Run from this repo:

```powershell
node scripts\install-extension-shim.mjs
```

Then reload Copilot CLI extensions. If both the user extension and the project extension load, the project extension intentionally skips tool registration to avoid duplicate tools.

## Minimal bridge configuration

For local Scout or CLI routing, create `%USERPROFILE%\.copilot\uhura\config.json`:

```json
{
  "bridge": {
    "enabled": true,
    "url": "http://127.0.0.1:47871",
    "intervalMs": 2000,
    "autoStart": true
  }
}
```

When `bridge.enabled` is true, each loaded Uhura extension auto-starts the bridge if needed and registers its Copilot session by heartbeat. Omit `databasePath` and `discoveryFile` to use the default files under `%USERPROFILE%\.copilot\uhura`.

## Session identity and activity

Each session has a route like `repo-name-6c33d4e1`. Uhura chooses the route prefix from the Copilot session name, then the current working directory basename, then configured `session.alias`. The route suffix is the first eight safe characters from the Copilot session id.

Bridge clients can target a session by exact route, short id, friendly session name, cwd basename, or alias. Ambiguous names fail instead of guessing.

`GET /sessions` returns:

| Field | Meaning |
| --- | --- |
| `route` | Exact address for this session |
| `sessionId`, `shortId`, `alias`, `displayName`, `names`, `cwd` | Session identity and address aliases |
| `activityStatus` | `busy`, `idle`, `waiting`, or `unknown` |
| `isBusy`, `isIdle`, `isWaiting` | Boolean projections, or `null` when activity is `unknown` |
| `activityUpdatedAt` | Time the activity state last changed |
| `lastSeenAt` | Last bridge heartbeat |
| `pendingMessages` | Undelivered bridge messages for the route |

Older sessions that have not reloaded Uhura may still show `activityStatus: "unknown"` with `isIdle: null`. Reload the extension in those sessions to move them onto the current activity contract.

## Local bridge API

The bridge defaults to `http://127.0.0.1:47871` and writes `%USERPROFILE%\.copilot\uhura\bridge.json`.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Check bridge liveness and counts |
| `GET /sessions` | List registered Copilot CLI sessions |
| `POST /sessions/register` | Register or heartbeat a session |
| `POST /sessions/poll` | Let a session claim queued messages |
| `POST /messages` | Queue a prompt for one route or `target: "all"` |
| `POST /events` | Record bridge events |
| `GET /events` | Read events, optionally with `?since=<event-id-or-iso>` |

`POST /events` records deliberate events. Routine `assistant.message` chatter is ignored unless it has a `replyToMessageId` and non-empty `content`. `notification.message` is accepted when it has non-empty `content`.

You can start the bridge directly for debugging:

```powershell
npm run bridge
```

Equivalent direct command:

```powershell
node scripts\uhura-bridge.mjs --host 127.0.0.1 --port 47871
```

Add `--token-file`, `--database`, or `--discovery-file` to match non-default bridge config.

## Scout MCP setup

Add Uhura to Scout as a command MCP server:

```text
node <repo-root>\scripts\uhura-mcp.mjs
```

The MCP adapter exposes:

| Tool | Purpose |
| --- | --- |
| `uhura_discover` | Discover and health-check the local bridge |
| `uhura_sessions` | List or resolve Copilot CLI sessions |
| `uhura_send` | Send to one route, friendly session name, short id, cwd name, alias, or `all` |
| `uhura_events` | Read assistant reply and notification events from the bridge |
| `uhura_ask` | Send to one session and wait for its next assistant reply event |

Scout should read `%USERPROFILE%\.copilot\uhura\bridge.json` first and probe `healthUrl`. If the file is missing or stale, it can probe `http://127.0.0.1:47871/health`.

## Local CLI

Use the local CLI to test the same handlers that Scout gets through MCP:

```powershell
node scripts\uhura.mjs schema --summary
node scripts\uhura.mjs tools
node scripts\uhura.mjs sessions repo-name
node scripts\uhura.mjs send --to repo-name --prompt "SCOUT-PING"
node scripts\uhura.mjs events --route repo-name-6c33d4e1 --type assistant.message
node scripts\uhura.mjs call uhura_sessions --args-json "{\"target\":\"repo-name\"}"
```

The package declares a `uhura` bin, so a linked checkout can run the same commands as `uhura sessions`, `uhura send`, and `uhura call`.

CLI commands:

| Command | Purpose |
| --- | --- |
| `schema` | Emit the CLI schema |
| `tools` | List the MCP tool definitions |
| `mcp-server` | Start the stdio MCP server |
| `call <mcp-tool>` | Call any MCP tool with `--args-json` |
| `discover` | Alias for `uhura_discover` |
| `sessions` | Alias for `uhura_sessions` |
| `send` | Alias for `uhura_send` |
| `events` | Alias for `uhura_events` |
| `ask` | Alias for `uhura_ask` |

## Copilot extension tools

These bridge-focused tools are available inside a Copilot CLI session with the Uhura extension loaded:

| Tool | Purpose |
| --- | --- |
| `uhura_status` | Show this session route, activity state, config state, and bridge state |
| `uhura_notify` | Emit an explicit local bridge notification for Scout |

## Development

```powershell
npm test
node <audit-repo-skill>\scripts\audit-docs.mjs --repo <repo-root>
```

## License

MIT
