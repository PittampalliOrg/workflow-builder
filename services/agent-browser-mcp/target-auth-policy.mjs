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
  if (
    !assertion.startsWith(ASSERTION_PREFIX) ||
    Buffer.byteLength(assertion, "utf8") > MAX_ASSERTION_BYTES
  ) {
    return null;
  }
  return { assertion };
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
    async peek(browserSession) {
      const pending = entries.get(browserSession);
      return pending ? await pending : null;
    },
    async resolve(browserSession, input) {
      const pendingExisting = entries.get(browserSession);
      if (pendingExisting) {
        const existing = await pendingExisting;
        if (!targetAuthNeedsRefresh(existing, now(), refreshWindowSeconds)) {
          return existing;
        }
        entries.delete(browserSession);
      }
      const pending = Promise.resolve().then(() => exchange(input));
      entries.set(browserSession, pending);
      try {
        const resolved = await pending;
        if (!resolved) entries.delete(browserSession);
        return resolved;
      } catch (error) {
        entries.delete(browserSession);
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
