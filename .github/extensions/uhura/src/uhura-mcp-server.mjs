import { createInterface } from "node:readline";
import { uhuraMcpToolDefinitions } from "./uhura-mcp-tools.mjs";

const PROTOCOL_VERSION = "2024-11-05";

function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

function toolList() {
  return uhuraMcpToolDefinitions.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

function success(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function failure(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function handleMcpRequest(message, options = {}) {
  if (message.jsonrpc !== "2.0") {
    return failure(message.id ?? null, -32600, "Invalid JSON-RPC request.");
  }
  if (message.id === undefined && typeof message.method === "string" && message.method.startsWith("notifications/")) {
    return undefined;
  }

  if (message.method === "initialize") {
    return success(message.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "uhura", version: "0.1.0" },
      instructions: "Use Uhura tools for @uhura Scout commands. Do not ask target Copilot sessions to call uhura_send.",
    });
  }

  if (message.method === "ping") {
    return success(message.id, {});
  }

  if (message.method === "tools/list") {
    return success(message.id, { tools: toolList() });
  }

  if (message.method === "tools/call") {
    const tool = uhuraMcpToolDefinitions.find((candidate) => candidate.name === message.params?.name);
    if (tool === undefined) {
      return failure(message.id, -32602, `Unknown Uhura tool: ${message.params?.name}`);
    }
    try {
      const result = await tool.handler(message.params?.arguments ?? {}, options);
      return success(message.id, {
        content: [{ type: "text", text: jsonText(result) }],
        isError: result?.ok === false,
      });
    } catch (err) {
      return success(message.id, {
        content: [{ type: "text", text: jsonText({ ok: false, error: err instanceof Error ? err.message : String(err) }) }],
        isError: true,
      });
    }
  }

  return failure(message.id, -32601, `Method not found: ${message.method}`);
}

export function startMcpStdioServer(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const serverOptions = {
    discoveryFile: options.discoveryFile,
    baseUrl: options.baseUrl,
  };
  const lines = createInterface({ input, crlfDelay: Infinity });

  lines.on("line", (line) => {
    const text = line.trim();
    if (text.length === 0) {
      return;
    }
    (async () => {
      try {
        const response = await handleMcpRequest(JSON.parse(text), serverOptions);
        if (response !== undefined) {
          output.write(`${JSON.stringify(response)}\n`);
        }
      } catch (err) {
        output.write(`${JSON.stringify(failure(null, -32700, err instanceof Error ? err.message : String(err)))}\n`);
      }
    })();
  });
}
