import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startMcpStdioServer } from "./uhura-mcp-server.mjs";
import { uhuraMcpToolDefinitions } from "./uhura-mcp-tools.mjs";

const TOOL_ALIASES = new Map([
  ["discover", "uhura_discover"],
  ["sessions", "uhura_sessions"],
  ["send", "uhura_send"],
  ["events", "uhura_events"],
  ["ask", "uhura_ask"],
]);

function packageVersion() {
  const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "package.json");
  return JSON.parse(readFileSync(packagePath, "utf8")).version;
}

function usage() {
  return [
    `uhura v${packageVersion()}`,
    "",
    "Usage:",
    "  uhura schema [--summary]",
    "  uhura tools",
    "  uhura mcp-server [--discovery-file path] [--base-url url]",
    "  uhura call <mcp-tool> [--args-json json]",
    "  uhura discover",
    "  uhura sessions [target]",
    "  uhura send --to target --prompt text [--from label]",
    "  uhura events [--since cursor-or-iso] [--route route] [--type event-type]",
    "  uhura ask --to target --prompt text [--timeout-ms ms]",
    "",
    "Global options:",
    "  --base-url url          Bridge URL, default http://127.0.0.1:47871",
    "  --discovery-file path   Override bridge discovery file",
    "  --compact               Emit one-line JSON",
  ].join("\n");
}

function parseOptions(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${arg} requires a value.`);
      }
      return argv[index];
    };
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--summary") {
      options.summary = true;
    } else if (arg === "--compact") {
      options.compact = true;
    } else if (arg === "--base-url") {
      options.baseUrl = next();
    } else if (arg === "--discovery-file") {
      options.discoveryFile = next();
    } else if (arg === "--args-json") {
      options.argsJson = next();
    } else if (arg === "--target") {
      options.target = next();
    } else if (arg === "--to") {
      options.to = next();
    } else if (arg === "--route") {
      options.route = next();
    } else if (arg === "--prompt") {
      options.prompt = next();
    } else if (arg === "--from") {
      options.from = next();
    } else if (arg === "--since") {
      options.since = next();
    } else if (arg === "--type") {
      options.type = next();
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(next());
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { options, positional };
}

function outputJson(io, value, compact) {
  const indent = compact ? undefined : 2;
  io.stdout.write(`${JSON.stringify(value, null, indent)}\n`);
}

function toolSummary() {
  return uhuraMcpToolDefinitions.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export function buildCliSchema(options = {}) {
  const commandPaths = [
    ["schema"],
    ["tools"],
    ["mcp-server"],
    ["call", "<mcp-tool>"],
    ...uhuraMcpToolDefinitions.map((tool) => [tool.name]),
    ...[...TOOL_ALIASES.keys()].map((alias) => [alias]),
  ];
  if (options.summary) {
    return {
      schemaVersion: 1,
      cliVersion: packageVersion(),
      commandCount: commandPaths.length,
      commandPaths,
    };
  }
  return {
    schemaVersion: 1,
    cliVersion: packageVersion(),
    envelope: {
      stdout: "JSON for command results and schema output",
      stderr: "errors and human help text",
      successEnvelope: ["ok", "data"],
      errorEnvelope: ["ok", "error"],
    },
    commands: [
      { path: ["schema"], summary: "Emit the machine-readable Uhura CLI command catalog." },
      { path: ["tools"], summary: "List Uhura MCP tools exposed by this CLI." },
      { path: ["mcp-server"], summary: "Start the Uhura stdio MCP server." },
      { path: ["call", "<mcp-tool>"], summary: "Call any Uhura MCP tool by name with --args-json." },
      ...uhuraMcpToolDefinitions.map((tool) => ({
        path: [tool.name],
        summary: tool.description,
        inputSchema: tool.inputSchema,
      })),
      ...[...TOOL_ALIASES.entries()].map(([alias, toolName]) => ({
        path: [alias],
        summary: `Alias for ${toolName}.`,
        mcpTool: toolName,
      })),
    ],
  };
}

function argsFromOptions(toolName, options, positional) {
  const fromJson = options.argsJson === undefined ? {} : JSON.parse(options.argsJson);
  if (toolName === "uhura_sessions") {
    return { ...fromJson, target: options.target ?? positional[0] ?? fromJson.target };
  }
  if (toolName === "uhura_send" || toolName === "uhura_ask") {
    const prompt = options.prompt ?? fromJson.prompt ?? positional.slice(1).join(" ");
    return {
      ...fromJson,
      to: options.to ?? options.target ?? positional[0] ?? fromJson.to,
      route: options.route ?? fromJson.route,
      prompt,
      from: options.from ?? fromJson.from,
      timeoutMs: options.timeoutMs ?? fromJson.timeoutMs,
    };
  }
  if (toolName === "uhura_events") {
    return {
      ...fromJson,
      since: options.since ?? fromJson.since,
      route: options.route ?? fromJson.route,
      type: options.type ?? fromJson.type,
    };
  }
  return fromJson;
}

async function callTool(toolName, args, options, fetchFn) {
  const tool = uhuraMcpToolDefinitions.find((candidate) => candidate.name === toolName);
  if (tool === undefined) {
    throw new Error(`Unknown Uhura MCP tool: ${toolName}`);
  }
  return tool.handler(args, {
    baseUrl: options.baseUrl,
    discoveryFile: options.discoveryFile,
    fetchFn,
  });
}

export async function runUhuraCli(argv, io = {}) {
  const streams = {
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
  };
  try {
    if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
      streams.stdout.write(`${usage()}\n`);
      return 0;
    }
    const command = argv[0];
    const { options, positional } = parseOptions(argv.slice(1));
    if (command === "schema") {
      outputJson(streams, buildCliSchema({ summary: options.summary }), options.compact);
      return 0;
    }
    if (command === "tools") {
      outputJson(streams, { ok: true, tools: toolSummary() }, options.compact);
      return 0;
    }
    if (command === "mcp-server") {
      startMcpStdioServer({ baseUrl: options.baseUrl, discoveryFile: options.discoveryFile });
      return 0;
    }
    const toolName = command === "call"
      ? positional[0]
      : TOOL_ALIASES.get(command) ?? command;
    const toolPositionals = command === "call" ? positional.slice(1) : positional;
    const args = argsFromOptions(toolName, options, toolPositionals);
    const result = await callTool(toolName, args, options, io.fetchFn);
    outputJson(streams, result, options.compact);
    return result?.ok === false ? 1 : 0;
  } catch (err) {
    outputJson(streams, { ok: false, error: err instanceof Error ? err.message : String(err) }, false);
    return 1;
  }
}
