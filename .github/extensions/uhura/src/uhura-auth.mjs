import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG_DIR = join(homedir(), ".uhura");
export const DEFAULT_AUTH_PATH = join(CONFIG_DIR, "auth.json");
export const DEFAULT_PROFILE_DIR = join(CONFIG_DIR, "browser-profile");
const TEAMS_URLS = [
  "https://www.office.com/",
  "https://outlook.office.com/mail/",
  "https://outlook.office.com/calendar/",
  "https://teams.cloud.microsoft/v2/",
  "https://teams.cloud.microsoft/v2/chat",
  "https://teams.microsoft.com/v2/",
  "https://teams.microsoft.com/v2/chat",
];
const LOGIN_TIMEOUT_MS = 180_000;
const PAGE_TIMEOUT_MS = 30_000;
const NETWORK_IDLE_MS = 15_000;

export function decodeJwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function classifyToken(token) {
  const payload = decodeJwtPayload(token);
  if (payload === undefined) {
    return undefined;
  }
  const audience = String(payload.aud ?? "").toLowerCase();
  const scopes = String(payload.scp ?? "").split(" ").filter(Boolean);
  if (audience.includes("graph.microsoft.com")) {
    return { type: "graph", scopes };
  }
  if (audience.includes("outlook.office.com") || audience.includes("outlook.office365.com")) {
    return { type: "outlook", scopes };
  }
  return undefined;
}

export function hasTeamsGraphScopes(scopes) {
  return scopes.some((scope) => /^(chat\.read|chat\.readwrite|chatmessage\.send|channelmessage\.send|channelmessage\.read\.all)$/i.test(scope));
}

export function hasGraphReadScopes(scopes) {
  return scopes.some((scope) => /^(chat\.readbasic|chat\.read|chat\.readwrite)$/i.test(scope));
}

export function hasGraphSendScopes(scopes) {
  return scopes.some((scope) => /^(chatmessage\.send|channelmessage\.send)$/i.test(scope));
}

function scoreTeamsToken(scopes) {
  let score = scopes.length;
  if (hasTeamsGraphScopes(scopes)) {
    score += 1000;
  }
  if (scopes.some((scope) => /^chatmessage\.send$/i.test(scope))) {
    score += 200;
  }
  if (scopes.some((scope) => /^channelmessage\.send$/i.test(scope))) {
    score += 200;
  }
  if (scopes.some((scope) => /^chat\.(read|readwrite)$/i.test(scope))) {
    score += 100;
  }
  return score;
}

export function selectBestTeamsToken(tokens) {
  return tokens
    .map((token) => ({ token, info: classifyToken(token) }))
    .filter((candidate) => candidate.info?.type === "graph")
    .sort((left, right) => scoreTeamsToken(right.info.scopes) - scoreTeamsToken(left.info.scopes))[0]?.token;
}

function scoreReadToken(scopes) {
  let score = scopes.length;
  if (scopes.some((scope) => /^chat\.readwrite$/i.test(scope))) score += 300;
  if (scopes.some((scope) => /^chat\.read$/i.test(scope))) score += 200;
  if (scopes.some((scope) => /^chat\.readbasic$/i.test(scope))) score += 100;
  return score;
}

function scoreSendToken(scopes) {
  let score = scopes.length;
  if (scopes.some((scope) => /^chatmessage\.send$/i.test(scope))) score += 300;
  if (scopes.some((scope) => /^channelmessage\.send$/i.test(scope))) score += 200;
  return score;
}

export function selectGraphTokenPair(tokens) {
  const graphCandidates = tokens
    .map((token) => ({ token, info: classifyToken(token) }))
    .filter((candidate) => candidate.info?.type === "graph");
  const readToken = graphCandidates
    .filter((candidate) => hasGraphReadScopes(candidate.info.scopes))
    .sort((left, right) => scoreReadToken(right.info.scopes) - scoreReadToken(left.info.scopes))[0]?.token;
  const sendToken = graphCandidates
    .filter((candidate) => hasGraphSendScopes(candidate.info.scopes))
    .sort((left, right) => scoreSendToken(right.info.scopes) - scoreSendToken(left.info.scopes))[0]?.token;
  return { readToken, sendToken };
}

export function readAuthState(authPath = DEFAULT_AUTH_PATH) {
  if (!existsSync(authPath)) {
    return {};
  }
  return JSON.parse(readFileSync(authPath, "utf8"));
}

export function writeAuthState(authState, authPath = DEFAULT_AUTH_PATH) {
  mkdirSync(dirname(authPath), { recursive: true });
  const tempPath = `${authPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(authState, null, 2), "utf8");
  renameSync(tempPath, authPath);
  return authState;
}

export function readIntegratedAccessToken(authPath = DEFAULT_AUTH_PATH) {
  const authState = readAuthState(authPath);
  if (typeof authState.graphToken !== "string") {
    throw new Error("Uhura has no integrated Teams Graph token. Run uhura_auth first.");
  }
  return authState.graphToken;
}

export function readIntegratedAccessTokenForPurpose(purpose, authPath = DEFAULT_AUTH_PATH) {
  const authState = readAuthState(authPath);
  const token = purpose === "read"
    ? authState.graphReadToken ?? authState.graphToken
    : authState.graphSendToken ?? authState.graphReadToken ?? authState.graphToken;
  if (typeof token !== "string") {
    throw new Error(`Uhura has no integrated Teams Graph ${purpose} token. Run uhura_auth first.`);
  }
  return token;
}

export function readAuthStatus(authPath = DEFAULT_AUTH_PATH) {
  const authState = readAuthState(authPath);
  const graphScopes = Array.isArray(authState.graphScopes) ? authState.graphScopes : [];
  const graphReadScopes = Array.isArray(authState.graphReadScopes) ? authState.graphReadScopes : [];
  const graphSendScopes = Array.isArray(authState.graphSendScopes) ? authState.graphSendScopes : [];
  return {
    exists: existsSync(authPath),
    hasGraphToken: typeof authState.graphToken === "string",
    hasGraphReadToken: typeof (authState.graphReadToken ?? authState.graphToken) === "string" && hasGraphReadScopes(graphReadScopes.length > 0 ? graphReadScopes : graphScopes),
    hasGraphSendToken: typeof (authState.graphSendToken ?? authState.graphToken) === "string" && hasGraphSendScopes(graphSendScopes.length > 0 ? graphSendScopes : graphScopes),
    hasTeamsGraphScopes: hasTeamsGraphScopes([...new Set([...graphScopes, ...graphReadScopes, ...graphSendScopes])]),
    graphScopes,
    graphReadScopes,
    graphSendScopes,
    authPath,
  };
}

function isLoginUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes("login.microsoftonline.com")
      || host.includes("login.microsoft.com")
      || host.includes("login.live.com");
  } catch {
    return false;
  }
}

function readBearerToken(headers) {
  const authorization = headers.authorization ?? headers.Authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return undefined;
  }
  return authorization.slice("Bearer ".length);
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error("Playwright is not installed for Uhura. Run npm install in the copilot-cli-uhura repo.");
  }
}

async function settlePage(page) {
  await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_MS }).catch(() => {});
}

export async function authenticateWithTeams(options = {}) {
  const authPath = options.authPath ?? DEFAULT_AUTH_PATH;
  const profileDir = options.profileDir ?? DEFAULT_PROFILE_DIR;
  const forceVisible = options.forceVisible === true;
  const log = typeof options.log === "function" ? options.log : () => {};
  const playwright = options.playwright ?? await loadPlaywright();
  const capturedTokens = new Set();

  mkdirSync(profileDir, { recursive: true });

  let context = await playwright.chromium.launchPersistentContext(profileDir, {
    channel: "msedge",
    headless: !forceVisible,
    args: ["--disable-blink-features=AutomationControlled"],
    viewport: { width: 1280, height: 900 },
  });

  function captureRequest(request) {
    const token = readBearerToken(request.headers());
    if (token !== undefined && classifyToken(token)?.type === "graph") {
      capturedTokens.add(token);
    }
  }

  context.on("request", captureRequest);
  let page = context.pages()[0] ?? await context.newPage();
  page.on("request", captureRequest);
  let cdp;
  try {
    cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.requestWillBeSent", (event) => captureHeaders(event.request?.headers));
    cdp.on("Network.requestWillBeSentExtraInfo", (event) => captureHeaders(event.headers));
  } catch (err) {
    log(`CDP token capture unavailable: ${err.message}`);
  }

  function captureHeaders(headers) {
    const token = readBearerToken(headers ?? {});
    if (token !== undefined && classifyToken(token)?.type === "graph") {
      capturedTokens.add(token);
    }
  }

  try {
    for (const url of TEAMS_URLS) {
      log(`Opening ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS }).catch((err) => log(`Navigation failed: ${err.message}`));
      if (!forceVisible && isLoginUrl(page.url())) {
        await context.close();
        log("Interactive sign-in required. Reopening Teams in visible Edge.");
        context = await playwright.chromium.launchPersistentContext(profileDir, {
          channel: "msedge",
          headless: false,
          args: ["--disable-blink-features=AutomationControlled"],
          viewport: { width: 1280, height: 900 },
        });
        context.on("request", captureRequest);
        page = context.pages()[0] ?? await context.newPage();
        page.on("request", captureRequest);
        try {
          cdp = await context.newCDPSession(page);
          await cdp.send("Network.enable");
          cdp.on("Network.requestWillBeSent", (event) => captureHeaders(event.request?.headers));
          cdp.on("Network.requestWillBeSentExtraInfo", (event) => captureHeaders(event.headers));
        } catch (err) {
          log(`CDP token capture unavailable after visible relaunch: ${err.message}`);
        }
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
      }
      if (isLoginUrl(page.url())) {
        log("Waiting for interactive sign-in to complete.");
        await page.waitForURL((candidate) => !isLoginUrl(candidate.toString()), { timeout: LOGIN_TIMEOUT_MS });
      }
      await settlePage(page);
      await page.evaluate(async () => {
        await Promise.allSettled([
          fetch("https://graph.microsoft.com/v1.0/me"),
          fetch("https://graph.microsoft.com/v1.0/me/chats?$top=5"),
          fetch("https://graph.microsoft.com/v1.0/me/joinedTeams"),
        ]);
      }).catch((err) => log(`Graph browser probe failed: ${err.message}`));
      await settlePage(page);
    }
  } finally {
    await context.close();
  }

  const graphToken = selectBestTeamsToken([...capturedTokens]);
  const { readToken, sendToken } = selectGraphTokenPair([...capturedTokens]);
  if (graphToken === undefined) {
    throw new Error("Teams did not emit a Graph token with Teams scopes. Open Teams in the Uhura browser profile and try uhura_auth again.");
  }
  const graphScopes = classifyToken(graphToken)?.scopes ?? [];
  const graphReadScopes = classifyToken(readToken)?.scopes ?? [];
  const graphSendScopes = classifyToken(sendToken)?.scopes ?? [];
  const authState = {
    graphToken,
    ...(readToken && { graphReadToken: readToken }),
    ...(sendToken && { graphSendToken: sendToken }),
    graphScopes,
    ...(graphReadScopes.length > 0 && { graphReadScopes }),
    ...(graphSendScopes.length > 0 && { graphSendScopes }),
    capturedAt: new Date().toISOString(),
  };
  writeAuthState(authState, authPath);
  return readAuthStatus(authPath);
}
