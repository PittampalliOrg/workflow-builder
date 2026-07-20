import { createHash } from "node:crypto";

export const WORKFLOW_BUILDER_ACCESS_TOKEN_COOKIE = "wb_access_token";
export const TARGET_AUTH_ASSERTION_HEADER = "x-wfb-browser-target-assertion";

const ASSERTION_PREFIX = "wfb_browser_auth_v1.";
const AUTHORIZATION_BINDING_PREFIX = "wfb_browser_binding_v1.";
const AUTHORIZATION_BINDING_PATTERN =
  /^wfb_browser_binding_v1\.[A-Za-z0-9_-]{43}$/;
const MAX_ASSERTION_BYTES = 2_048;
const MAX_EXCHANGE_RESPONSE_BYTES = 16_384;
const MAX_VALIDATION_RESPONSE_BYTES = 512;
const DEFAULT_TARGET_AUTH_HTTP_TIMEOUT_MS = 30_000;
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
 * child process, or BrowserStation lane is selected. Browser access is a
 * workflow capability; executionless callers are always rejected.
 */
export async function authorizeBrowserInitialization({
  executionId,
  targetAuth,
  validate,
}) {
  const normalizedExecutionId =
    typeof executionId === "string" ? executionId.trim() : "";
  const assertion =
    typeof targetAuth?.assertion === "string"
      ? targetAuth.assertion.trim()
      : "";
  if (!normalizedExecutionId) return null;
  const assertionDigest = targetAuthAssertionDigest(assertion);
  if (!assertionDigest || typeof validate !== "function") return null;
  let authorizationBinding;
  try {
    authorizationBinding = parseTargetAuthorizationBinding(
      await validate({
        assertion,
        executionId: normalizedExecutionId,
      }),
    );
  } catch {
    return null;
  }
  if (!authorizationBinding) return null;
  return {
    executionId: normalizedExecutionId,
    targetAuth: { assertion },
    assertionDigest,
    authorizationBinding,
  };
}

export function parseTargetAuthorizationBinding(value) {
  if (typeof value !== "string") return null;
  const binding = value.trim();
  return value === binding && AUTHORIZATION_BINDING_PATTERN.test(binding)
    ? binding
    : null;
}

/** Reauthorize every request; the MCP session id is routing state, not auth. */
export async function reauthorizeBrowserSession({
  executionId,
  targetAuth,
  expectedExecutionId,
  expectedAssertionDigest,
  expectedAuthorizationBinding,
  browserContext,
  isBrowserContextCurrent,
  validate,
}) {
  const normalizedExecutionId =
    typeof executionId === "string" ? executionId.trim() : "";
  const assertion =
    typeof targetAuth?.assertion === "string"
      ? targetAuth.assertion.trim()
      : "";
  const digest = targetAuthAssertionDigest(assertion);
  if (
    !normalizedExecutionId ||
    normalizedExecutionId !== expectedExecutionId ||
    !digest ||
    digest !== expectedAssertionDigest ||
    !parseTargetAuthorizationBinding(expectedAuthorizationBinding) ||
    typeof isBrowserContextCurrent !== "function" ||
    !isBrowserContextCurrent(browserContext, expectedAuthorizationBinding) ||
    typeof validate !== "function"
  ) {
    return false;
  }
  try {
    return (
      parseTargetAuthorizationBinding(
        await validate({ assertion, executionId: normalizedExecutionId }),
      ) === expectedAuthorizationBinding
    );
  } catch {
    return false;
  }
}

/**
 * DELETE removes only the exact local MCP capability. It remains available
 * after the shared browser context closes so transport and child cleanup can
 * complete without requiring a live run or browser lane.
 */
export function authorizeBrowserSessionTermination({
  sessionId,
  executionId,
  targetAuth,
  expectedSessionId,
  expectedExecutionId,
  expectedAssertionDigest,
}) {
  const normalizedSessionId =
    typeof sessionId === "string" ? sessionId.trim() : "";
  const normalizedExecutionId =
    typeof executionId === "string" ? executionId.trim() : "";
  const assertion =
    typeof targetAuth?.assertion === "string"
      ? targetAuth.assertion.trim()
      : "";
  return Boolean(
    normalizedSessionId &&
    normalizedSessionId === expectedSessionId &&
    normalizedExecutionId &&
    normalizedExecutionId === expectedExecutionId &&
    targetAuthAssertionDigest(assertion) === expectedAssertionDigest,
  );
}

/**
 * Permit the MCP client's one schema-cache refresh after browser close.
 *
 * Closing the browser invalidates the live browser capability, but MCP clients
 * may issue one tools/list after a successful tools/call to validate its output
 * schema. The caller owns and atomically consumes `schemaRefreshAvailable`
 * before forwarding the request; this predicate never mutates session state.
 */
export function authorizeBrowserSessionPostCloseToolsList({
  method,
  schemaRefreshAvailable,
  browserContext,
  sessionId,
  executionId,
  targetAuth,
  expectedSessionId,
  expectedExecutionId,
  expectedAssertionDigest,
}) {
  if (
    method !== "tools/list" ||
    schemaRefreshAvailable !== true ||
    browserContext?.closing !== true ||
    browserContext?.closeResponseSettled !== true
  ) {
    return false;
  }
  return authorizeBrowserSessionTermination({
    sessionId,
    executionId,
    targetAuth,
    expectedSessionId,
    expectedExecutionId,
    expectedAssertionDigest,
  });
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

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function hasStrictJsonNoStore(response) {
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    ?.toLowerCase();
  const cacheDirectives = response.headers
    .get("cache-control")
    ?.split(",")
    .map((directive) => directive.trim().toLowerCase());
  return (
    mediaType === "application/json" && cacheDirectives?.includes("no-store")
  );
}

async function readBoundedJson(response, maxBytes) {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)
  ) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) return null;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!totalBytes) return null;
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return text ? JSON.parse(text) : null;
}

/** Validate the BFF response before a credential reaches the browser daemon. */
export function parseTargetAuthExchange(payload, nowMs = Date.now()) {
  if (!hasExactKeys(payload, ["targetOrigin", "cookie"])) return null;
  const targetOrigin = parseOrigin(payload.targetOrigin);
  const cookie = payload.cookie;
  if (
    !targetOrigin ||
    !hasExactKeys(cookie, [
      "name",
      "value",
      "expiresAt",
      "httpOnly",
      "secure",
      "sameSite",
      "path",
    ])
  ) {
    return null;
  }
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
  let entry = null;
  function inputBinding(input) {
    return parseTargetAuthorizationBinding(input?.authorizationBinding);
  }
  return {
    prime(input, value) {
      const authorizationBinding = inputBinding(input);
      if (!authorizationBinding || !value) return false;
      if (entry && entry.authorizationBinding !== authorizationBinding) {
        return false;
      }
      entry = {
        authorizationBinding,
        pending: Promise.resolve(value),
      };
      return true;
    },
    async peek(input) {
      const authorizationBinding = inputBinding(input);
      return authorizationBinding &&
        entry?.authorizationBinding === authorizationBinding
        ? await entry.pending
        : null;
    },
    async resolve(input) {
      const authorizationBinding = inputBinding(input);
      if (!authorizationBinding) return null;
      if (entry && entry.authorizationBinding !== authorizationBinding) {
        return null;
      }
      if (entry) {
        const existing = await entry.pending;
        if (!targetAuthNeedsRefresh(existing, now(), refreshWindowSeconds)) {
          return existing;
        }
        entry = null;
      }
      const pending = Promise.resolve().then(() => exchange(input));
      entry = { authorizationBinding, pending };
      try {
        const resolved = await pending;
        if (!resolved && entry?.pending === pending) {
          entry = null;
        }
        return resolved;
      } catch (error) {
        if (entry?.pending === pending) {
          entry = null;
        }
        throw error;
      }
    },
    clear() {
      entry = null;
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
  timeoutMs = DEFAULT_TARGET_AUTH_HTTP_TIMEOUT_MS,
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
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Internal-Token": internalToken,
      },
      body: JSON.stringify({
        targetAuthAssertion: assertion,
        executionId,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200 || !hasStrictJsonNoStore(response)) return null;
    const payload = await readBoundedJson(
      response,
      MAX_EXCHANGE_RESPONSE_BYTES,
    );
    return parseTargetAuthExchange(payload, nowMs);
  } catch {
    return null;
  }
}

/** Validate current execution authorization without minting or retaining a cookie. */
export async function validateTargetAuth({
  bffUrl,
  internalToken,
  assertion,
  executionId,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TARGET_AUTH_HTTP_TIMEOUT_MS,
}) {
  if (!internalToken || !assertion || !executionId) return null;
  let endpoint;
  try {
    endpoint = new URL(
      "/api/internal/browser-target-auth/validate",
      `${bffUrl.replace(/\/$/, "")}/`,
    ).toString();
  } catch {
    return null;
  }
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Internal-Token": internalToken,
      },
      body: JSON.stringify({
        targetAuthAssertion: assertion,
        executionId,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return null;
    if (!hasStrictJsonNoStore(response)) return null;
    const payload = await readBoundedJson(
      response,
      MAX_VALIDATION_RESPONSE_BYTES,
    );
    if (!hasExactKeys(payload, ["authorizationBinding"])) {
      return null;
    }
    return parseTargetAuthorizationBinding(payload.authorizationBinding);
  } catch {
    return null;
  }
}
