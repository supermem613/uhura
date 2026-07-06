import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyToken,
  hasTeamsGraphScopes,
  readAuthStatus,
  readIntegratedAccessToken,
  selectBestTeamsToken,
  selectGraphTokenPair,
  writeAuthState,
} from "../.github/extensions/uhura/src/uhura-auth.mjs";

function token(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encodedPayload}.signature`;
}

test("classifies Graph and Outlook bearer tokens by audience and scopes", () => {
  const graph = token({ aud: "https://graph.microsoft.com", scp: "Chat.Read ChatMessage.Send" });
  const outlook = token({ aud: "https://outlook.office.com", scp: "Mail.Read" });

  assert.deepEqual(classifyToken(graph), { type: "graph", scopes: ["Chat.Read", "ChatMessage.Send"] });
  assert.deepEqual(classifyToken(outlook), { type: "outlook", scopes: ["Mail.Read"] });
});

test("selects the Teams-capable Graph token over a generic Graph token", () => {
  const generic = token({ aud: "https://graph.microsoft.com", scp: "User.Read" });
  const teams = token({ aud: "https://graph.microsoft.com", scp: "User.Read Chat.Read ChatMessage.Send" });

  assert.equal(selectBestTeamsToken([generic, teams]), teams);
  assert.equal(hasTeamsGraphScopes(classifyToken(teams).scopes), true);
});

test("selects separate Graph read and send tokens", () => {
  const read = token({ aud: "https://graph.microsoft.com", scp: "User.Read Chat.Read Chat.ReadWrite" });
  const send = token({ aud: "https://graph.microsoft.com", scp: "User.Read ChatMessage.Send" });

  assert.deepEqual(selectGraphTokenPair([read, send]), { readToken: read, sendToken: send });
});

test("persists and reads Uhura integrated auth state", () => {
  const root = mkdtempSync(join(tmpdir(), "uhura-auth-"));
  try {
    const authPath = join(root, "auth.json");
    const teams = token({ aud: "https://graph.microsoft.com", scp: "Chat.Read ChatMessage.Send" });
    writeAuthState({ graphToken: teams, graphReadToken: teams, graphSendToken: teams, graphScopes: ["Chat.Read", "ChatMessage.Send"], graphReadScopes: ["Chat.Read"], graphSendScopes: ["ChatMessage.Send"] }, authPath);

    assert.equal(readIntegratedAccessToken(authPath), teams);
    assert.deepEqual(readAuthStatus(authPath), {
      exists: true,
      hasGraphToken: true,
      hasGraphReadToken: true,
      hasGraphSendToken: true,
      hasTeamsGraphScopes: true,
      graphScopes: ["Chat.Read", "ChatMessage.Send"],
      graphReadScopes: ["Chat.Read"],
      graphSendScopes: ["ChatMessage.Send"],
      authPath,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
