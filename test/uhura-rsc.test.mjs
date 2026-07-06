import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildRscTokenRequest,
  parseRscTokenResponse,
  readRscClientSecret,
} from "../.github/extensions/uhura/src/uhura-rsc.mjs";

test("builds client credentials token request for RSC channel reads", () => {
  const request = buildRscTokenRequest({
    tenantId: "tenant",
    clientId: "client",
    clientSecret: "secret",
  });

  assert.equal(request.url, "https://login.microsoftonline.com/tenant/oauth2/v2.0/token");
  assert.equal(request.body.get("client_id"), "client");
  assert.equal(request.body.get("client_secret"), "secret");
  assert.equal(request.body.get("grant_type"), "client_credentials");
  assert.equal(request.body.get("scope"), "https://graph.microsoft.com/.default");
});

test("parses RSC token response", () => {
  assert.equal(parseRscTokenResponse(JSON.stringify({ access_token: "token" })), "token");
  assert.throws(() => parseRscTokenResponse(JSON.stringify({ error: "invalid_client" })), /access_token/);
});

test("reads RSC client secret from explicit file", () => {
  const root = mkdtempSync(join(tmpdir(), "uhura-rsc-secret-"));
  try {
    const secretPath = join(root, "secret.txt");
    writeFileSync(secretPath, " client-secret \n", "utf8");

    assert.equal(readRscClientSecret({ clientSecretFile: secretPath }), "client-secret");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
