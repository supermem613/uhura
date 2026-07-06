#!/usr/bin/env node

import { createBridgeServer, readBridgeServerToken } from "../.github/extensions/uhura/src/uhura-bridge-server.mjs";
import {
  buildBridgeDiscovery,
  defaultBridgeDatabasePath,
  defaultBridgeDiscoveryPath,
  writeBridgeDiscovery,
} from "../.github/extensions/uhura/src/uhura-bridge-store.mjs";

function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: 47871,
    databasePath: defaultBridgeDatabasePath(),
    discoveryFile: defaultBridgeDiscoveryPath(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${arg} requires a value.`);
      }
      return argv[index];
    };
    if (arg === "--host") {
      args.host = next();
    } else if (arg === "--port") {
      args.port = Number(next());
    } else if (arg === "--token-file") {
      args.tokenFile = next();
    } else if (arg === "--database") {
      args.databasePath = next();
    } else if (arg === "--discovery-file") {
      args.discoveryFile = next();
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
    "Usage: node scripts/uhura-bridge.mjs [--host 127.0.0.1] [--port 47871] [--token-file path] [--database path] [--discovery-file path]",
    "",
    "Local bridge for Scout/Clawpilot to route messages into visible Uhura Copilot CLI sessions.",
  ].join("\n");
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

const server = createBridgeServer({ token: readBridgeServerToken(args.tokenFile), databasePath: args.databasePath });
server.listen(args.port, args.host, () => {
  const discovery = buildBridgeDiscovery({ host: args.host, port: args.port, databasePath: args.databasePath });
  writeBridgeDiscovery(args.discoveryFile, discovery);
  process.stdout.write(JSON.stringify({ ok: true, bridge: discovery.baseUrl, discoveryFile: args.discoveryFile, databasePath: args.databasePath }) + "\n");
});
