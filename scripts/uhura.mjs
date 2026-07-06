#!/usr/bin/env node

import { runUhuraCli } from "../.github/extensions/uhura/src/uhura-cli.mjs";

process.exitCode = await runUhuraCli(process.argv.slice(2));
