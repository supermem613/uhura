#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repoRoot, ".github", "extensions", "uhura", "src", "uhura-extension.mjs");
const targetDir = join(homedir(), ".copilot", "extensions", "uhura");
const target = join(targetDir, "extension.mjs");

mkdirSync(targetDir, { recursive: true });
writeFileSync(target, `import { registerUhuraExtension } from ${JSON.stringify(pathToFileURL(source).href)};\n\nawait registerUhuraExtension({ source: "user" });\n`, "utf8");
process.stdout.write(JSON.stringify({ ok: true, extension: "uhura", target }, null, 2));
