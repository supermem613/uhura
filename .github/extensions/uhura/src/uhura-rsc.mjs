import { readFileSync } from "node:fs";

export function readRscClientSecret(config) {
  if (typeof config?.clientSecretFile !== "string" || config.clientSecretFile.length === 0) {
    throw new Error("RSC channel read requires channelRead.clientSecretFile.");
  }
  return readFileSync(config.clientSecretFile, "utf8").trim();
}

export function buildRscTokenRequest(config) {
  if (typeof config?.tenantId !== "string" || config.tenantId.length === 0) {
    throw new Error("RSC channel read requires channelRead.tenantId.");
  }
  if (typeof config?.clientId !== "string" || config.clientId.length === 0) {
    throw new Error("RSC channel read requires channelRead.clientId.");
  }
  if (typeof config?.clientSecret !== "string" || config.clientSecret.length === 0) {
    throw new Error("RSC channel read requires a client secret.");
  }

  const body = new URLSearchParams();
  body.set("client_id", config.clientId);
  body.set("client_secret", config.clientSecret);
  body.set("grant_type", "client_credentials");
  body.set("scope", "https://graph.microsoft.com/.default");

  return {
    url: `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
    body,
  };
}

export function parseRscTokenResponse(text) {
  const parsed = JSON.parse(text);
  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new Error("RSC token response did not include access_token.");
  }
  return parsed.access_token;
}

export async function readRscAccessToken(config) {
  const request = buildRscTokenRequest({
    ...config,
    clientSecret: readRscClientSecret(config),
  });
  const response = await fetch(request.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: request.body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`RSC token request failed: ${text}`);
  }
  return parseRscTokenResponse(text);
}
