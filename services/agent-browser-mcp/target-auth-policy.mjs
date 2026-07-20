import { createHash } from "node:crypto";

export const WORKFLOW_BUILDER_ACCESS_TOKEN_COOKIE = "wb_access_token";
export const TARGET_AUTH_ASSERTION_HEADER = "x-wfb-browser-target-assertion";

const ASSERTION_PREFIX = "wfb_browser_auth_v1.";
const MAX_ASSERTION_BYTES = 2_048;
const MAX_COOKIE_LIFETIME_SECONDS = 30 * 60;
const CLOCK_SKEW_SECONDS = 10;
export const TARGET_AUTH_REFRESH_WINDOW_SECONDS = 5 * 60;

/** The only execution-config value accepted by the bridge is a purpose proof. */
export function parseTargetAuthAssertion(headers) {
  const assertion = String(headers[TARGET_AUTH_ASSERTION_HEADER] || "").trim();
  if (!targetAuthAssertionDigest(assertion)) {
    return null;
  }
  return { assertion };
}

/** Stable, non-secret binding for cache, lane, and MCP-session ownership. */
export function targetAuthAssertionDigest(assertion) {
  if (typeof assertion !== "string") return null;
  const normalized = assertion.trim();
  if (
    !normalized.startsWith(ASSERTION_PREFIX) ||
    Buffer.byteLength(normalized, "utf8") > MAX_ASSERTION_BYTES
  ) {
    return null;
  }
  return createHash("sha256").update(normalized, "utf8").digest("base64url");
}

/**
 * Authorize an MCP initialization before any execution-scoped browser key,
 * child process, or BrowserStation lane is selected. Anonymous callers remain
 * supported only when they present neither an execution id nor an assertion.
 */
export async function authorizeBrowserInitialization({
  executionId,
  targetAuth,
  exchange,
}) {
  const normalizedExecutionId =
    typeof executionId === "string" ? executionId.trim() : "";
  const assertion =
    typeof targetAuth?.assertion === "string"
      ? targetAuth.assertion.trim()
      : "";
  if (!normalizedExecutionId) {
    return assertion
      ? null
      : {
          executionId: null,
          targetAuth: null,
          assertionDigest: null,
          targetAuthExchange: null,
        };
  }
  const assertionDigest = targetAuthAssertionDigest(assertion);
  if (!assertionDigest || typeof exchange !== "function") return null;
  let targetAuthExchange;
  try {
    targetAuthExchange = await exchange({
      assertion,
      executionId: normalizedExecutionId,
    });
  } catch {
    return null;
  }
  if (!targetAuthExchange) return null;
  return {
    executionId: normalizedExecutionId,
    targetAuth: { assertion },
    assertionDigest,
    targetAuthExchange,
  };
}

/** Exact-assertion binding for every reusable browser-session/lane key. */
export function createTargetAuthSessionBindings() {
  const entries = new Map();
  return {
    bind(browserSession, assertion) {
      const digest = targetAuthAssertionDigest(assertion);
      if (!browserSession || !digest) return null;
      const existing = entries.get(browserSession);
      if (existing && existing !== digest) return null;
      entries.set(browserSession, digest);
      return digest;
    },
    matches(browserSession, assertion) {
      const digest = targetAuthAssertionDigest(assertion);
      return Boolean(digest && entries.get(browserSession) === digest);
    },
    clear(browserSession) {
      entries.delete(browserSession);
    },
  };
}

function parseOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin !== value
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/** Validate the BFF response before a credential reaches the browser daemon. */
export function parseTargetAuthExchange(payload, nowMs = Date.now()) {
  if (!payload || typeof payload !== "object") return null;
  const targetOrigin = parseOrigin(payload.targetOrigin);
  const cookie = payload.cookie;
  if (!targetOrigin || !cookie || typeof cookie !== "object") return null;
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (
    cookie.name !== WORKFLOW_BUILDER_ACCESS_TOKEN_COOKIE ||
    typeof cookie.value !== "string" ||
    !cookie.value ||
    !Number.isInteger(cookie.expiresAt) ||
    cookie.expiresAt <= nowSeconds - CLOCK_SKEW_SECONDS ||
    cookie.expiresAt >
      nowSeconds + MAX_COOKIE_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS ||
    cookie.httpOnly !== true ||
    cookie.secure !== targetOrigin.startsWith("https://") ||
    cookie.sameSite !== "Strict" ||
    cookie.path !== "/"
  ) {
    return null;
  }
  return {
    targetOrigin,
    cookie: {
      name: WORKFLOW_BUILDER_ACCESS_TOKEN_COOKIE,
      value: cookie.value,
      expiresAt: cookie.expiresAt,
      httpOnly: true,
      secure: cookie.secure,
      sameSite: "Strict",
      path: "/",
    },
  };
}

export function openedUrlMatchesTargetOrigin(openedUrl, targetOrigin) {
  try {
    return new URL(openedUrl).origin === targetOrigin;
  } catch {
    return false;
  }
}

export function targetAuthCookieToolArguments(exchange) {
  return {
    name: exchange.cookie.name,
    value: exchange.cookie.value,
    url: `${exchange.targetOrigin}/`,
    path: exchange.cookie.path,
    httpOnly: true,
    secure: exchange.cookie.secure,
    sameSite: "Strict",
    expires: exchange.cookie.expiresAt,
  };
}

export function targetAuthNeedsRefresh(
  exchange,
  nowMs = Date.now(),
  refreshWindowSeconds = TARGET_AUTH_REFRESH_WINDOW_SECONDS,
) {
  return (
    !exchange ||
    exchange.cookie.expiresAt <=
      Math.floor(nowMs / 1_000) + refreshWindowSeconds
  );
}

/** Run-scoped exchange cache with expiry-aware refresh and retry after failure. */
export function createTargetAuthExchangeCache({
  exchange = exchangeTargetAuth,
  now = () => Date.now(),
  refreshWindowSeconds = TARGET_AUTH_REFRESH_WINDOW_SECONDS,
} = {}) {
  const entries = new Map();
  return {
    prime(browserSession, input, value) {
      const digest = targetAuthAssertionDigest(input?.assertion);
      if (!browserSession || !digest || !value) return false;
      const existing = entries.get(browserSession);
      if (existing && existing.digest !== digest) return false;
      entries.set(browserSession, {
        digest,
        pending: Promise.resolve(value),
      });
      return true;
    },
    async peek(browserSession, input) {
      const digest = targetAuthAssertionDigest(input?.assertion);
      const entry = entries.get(browserSession);
      return digest && entry?.digest === digest ? await entry.pending : null;
    },
    async resolve(browserSession, input) {
      const digest = targetAuthAssertionDigest(input?.assertion);
      if (!browserSession || !digest) return null;
      const entry = entries.get(browserSession);
      if (entry && entry.digest !== digest) return null;
      if (entry) {
        const existing = await entry.pending;
        if (!targetAuthNeedsRefresh(existing, now(), refreshWindowSeconds)) {
          return existing;
        }
        entries.delete(browserSession);
      }
      const pending = Promise.resolve().then(() => exchange(input));
      entries.set(browserSession, { digest, pending });
      try {
        const resolved = await pending;
        if (!resolved && entries.get(browserSession)?.pending === pending) {
          entries.delete(browserSession);
        }
        return resolved;
      } catch (error) {
        if (entries.get(browserSession)?.pending === pending) {
          entries.delete(browserSession);
        }
        throw error;
      }
    },
    clear(browserSession) {
      entries.delete(browserSession);
    },
  };
}

/**
 * Exchange only with the bridge's configured BFF endpoint and service token.
 * The assertion is not an HTTP credential and is never placed in Authorization.
 */
export async function exchangeTargetAuth({
  bffUrl,
  internalToken,
  assertion,
  executionId,
  fetchImpl = fetch,
  nowMs = Date.now(),
}) {
  if (!internalToken || !assertion || !executionId) return null;
  let endpoint;
  try {
    endpoint = new URL(
      "/api/internal/browser-target-auth/exchange",
      `${bffUrl.replace(/\/$/, "")}/`,
    ).toString();
  } catch {
    return null;
  }
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": internalToken,
      },
      body: JSON.stringify({
        targetAuthAssertion: assertion,
        executionId,
      }),
    });
    if (!response.ok) return null;
    return parseTargetAuthExchange(await response.json(), nowMs);
  } catch {
    return null;
  }
}
