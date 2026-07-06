#!/usr/bin/env node

import { startMcpStdioServer } from "../.github/extensions/uhura/src/uhura-mcp-server.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${arg} requires a value.`);
      }
      return argv[index];
    };
    if (arg === "--discovery-file") {
      args.discoveryFile = next();
    } else if (arg === "--base-url") {
      args.baseUrl = next();
    } else if (arg === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/uhura-mcp.mjs [--discovery-file path] [--base-url http://127.0.0.1:47871]",
    "",
    "MCP stdio adapter for Scout to route @uhura messages through the local Uhura bridge.",
  ].join("\n");
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

startMcpStdioServer(args);
