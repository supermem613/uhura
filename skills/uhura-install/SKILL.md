---
name: uhura-install
description: |
  Install or refresh the Uhura Copilot CLI extension shim for Teams communication.
metadata:
  userInvocable: true
---

# uhura-install

Use when installing or refreshing Uhura as a user-scoped Copilot CLI extension.

## Steps

1. Run `node scripts\install-extension-shim.mjs` from the `uhura` repo.
2. Reload Copilot CLI extensions.
3. Use the `uhura_status` tool to confirm the route and config state.

## Configuration

Create `%USERPROFILE%\.copilot\uhura\config.json` before expecting Teams send or receive to work. Use the `uhura_config_example` tool for a redacted template.
