import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeBrowserInitialization,
  createTargetAuthExchangeCache,
  createTargetAuthSessionBindings,
  exchangeTargetAuth,
  openedUrlMatchesTargetOrigin,
  parseTargetAuthAssertion,
  parseTargetAuthExchange,
  reauthorizeBrowserSession,
  targetAuthAssertionDigest,
  targetAuthCookieToolArguments,
  validateTargetAuth,
  WORKFLOW_BUILDER_ACCESS_TOKEN_COOKIE,
} from "./target-auth-policy.mjs";

const nowMs = Date.parse("2026-07-20T20:00:00.000Z");
const nowSeconds = Math.floor(nowMs / 1_000);
const assertion = "wfb_browser_auth_v1.payload.signature";
const targetOrigin =
  "http://workflow-builder.workflow-builder.svc.cluster.local:3000";
const exchangePayload = {
  targetOrigin,
  cookie: {
    name: WORKFLOW_BUILDER_ACCESS_TOKEN_COOKIE,
    value: "short-lived-owner-cookie",
    expiresAt: nowSeconds + 300,
    httpOnly: true,
    secure: false,
    sameSite: "Strict",
    path: "/",
  },
};

test("accepts only the purpose assertion from execution config", () => {
  assert.deepEqual(
    parseTargetAuthAssertion({
      "x-wfb-browser-target-assertion": assertion,
      "x-wfb-target-auth": "Bearer must-not-be-used",
      "x-wfb-target-auth-host": "attacker.example",
    }),
    { assertion },
  );
  assert.equal(
    parseTargetAuthAssertion({
      "x-wfb-target-auth": "Bearer legacy-owner-token",
      "x-wfb-target-auth-host": "workflow-builder:3000",
    }),
    null,
  );
});

test("exchanges only against the configured BFF with service auth", async () => {
  const requests = [];
  const result = await exchangeTargetAuth({
    bffUrl: `${targetOrigin}/`,
    internalToken: "internal-service-token",
    assertion,
    executionId: "execution-1",
    nowMs,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(exchangePayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.deepEqual(result, exchangePayload);
  assert.equal(
    requests[0].url,
    `${targetOrigin}/api/internal/browser-target-auth/exchange`,
  );
  assert.deepEqual(requests[0].init.headers, {
    "Content-Type": "application/json",
    "X-Internal-Token": "internal-service-token",
  });
  assert.equal("Authorization" in requests[0].init.headers, false);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    targetAuthAssertion: assertion,
    executionId: "execution-1",
  });
});

test("fails execution initialization closed before browser allocation", async () => {
  const validate = async ({ assertion: supplied, executionId }) =>
    supplied === assertion && executionId === "execution-1" ? true : false;
  let allocated = false;
  const denied = await authorizeBrowserInitialization({
    executionId: "guessed-execution-id",
    targetAuth: { assertion },
    validate,
  });
  if (denied) allocated = true;
  assert.equal(denied, null);
  assert.equal(allocated, false);
  assert.equal(
    await authorizeBrowserInitialization({
      executionId: "",
      targetAuth: null,
      validate: async () => true,
    }),
    null,
  );
  assert.equal(
    await authorizeBrowserInitialization({
      executionId: "execution-1",
      targetAuth: null,
      validate: async () => {
        throw new Error("missing assertions must not be exchanged");
      },
    }),
    null,
  );
  assert.deepEqual(
    await authorizeBrowserInitialization({
      executionId: "execution-1",
      targetAuth: { assertion },
      validate,
    }),
    {
      executionId: "execution-1",
      targetAuth: { assertion },
      assertionDigest: targetAuthAssertionDigest(assertion),
    },
  );
});

test("revalidates the exact assertion on every existing-session request", async () => {
  const bindings = createTargetAuthSessionBindings();
  const browserSession = "wfb-execution-1";
  const assertionDigest = bindings.bind(browserSession, assertion);
  const validations = [];
  const authorize = (overrides = {}) =>
    reauthorizeBrowserSession({
      executionId: "execution-1",
      targetAuth: { assertion },
      expectedExecutionId: "execution-1",
      expectedAssertionDigest: assertionDigest,
      browserSession,
      bindings,
      validate: async (input) => {
        validations.push(input);
        return true;
      },
      ...overrides,
    });

  assert.equal(await authorize(), true);
  assert.equal(await authorize(), true);
  assert.equal(validations.length, 2);
  assert.equal(await authorize({ executionId: "guessed-execution" }), false);
  assert.equal(await authorize({ targetAuth: null }), false);
  assert.equal(
    await authorize({
      targetAuth: { assertion: "wfb_browser_auth_v1.other.signature" },
    }),
    false,
  );
  assert.equal(validations.length, 2);
});

test("fails existing sessions closed when authorization expires or is revoked", async () => {
  const bindings = createTargetAuthSessionBindings();
  const browserSession = "wfb-execution-1";
  const assertionDigest = bindings.bind(browserSession, assertion);
  for (const reason of ["terminal", "revoked", "expired"]) {
    let calls = 0;
    assert.equal(
      await reauthorizeBrowserSession({
        executionId: "execution-1",
        targetAuth: { assertion },
        expectedExecutionId: "execution-1",
        expectedAssertionDigest: assertionDigest,
        browserSession,
        bindings,
        validate: async () => {
          calls += 1;
          return false;
        },
      }),
      false,
      reason,
    );
    assert.equal(calls, 1, reason);
  }
  assert.equal(
    await reauthorizeBrowserSession({
      executionId: "execution-1",
      targetAuth: { assertion },
      expectedExecutionId: "execution-1",
      expectedAssertionDigest: assertionDigest,
      browserSession,
      bindings,
      validate: async () => {
        throw new Error("BFF unavailable");
      },
    }),
    false,
  );
});

test("validates against the fixed BFF without returning a credential", async () => {
  const requests = [];
  assert.equal(
    await validateTargetAuth({
      bffUrl: targetOrigin,
      internalToken: "internal-service-token",
      assertion,
      executionId: "execution-1",
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return new Response(null, { status: 204 });
      },
    }),
    true,
  );
  assert.equal(
    requests[0].url,
    `${targetOrigin}/api/internal/browser-target-auth/validate`,
  );
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    targetAuthAssertion: assertion,
    executionId: "execution-1",
  });
  assert.equal("Authorization" in requests[0].init.headers, false);
});

test("binds reusable browser sessions to the exact assertion", () => {
  const bindings = createTargetAuthSessionBindings();
  const otherAssertion = "wfb_browser_auth_v1.other.signature";
  assert.ok(bindings.bind("wfb-execution-1", assertion));
  assert.equal(bindings.matches("wfb-execution-1", assertion), true);
  assert.equal(bindings.matches("wfb-execution-1", ""), false);
  assert.equal(bindings.matches("wfb-execution-1", otherAssertion), false);
  assert.equal(bindings.bind("wfb-execution-1", otherAssertion), null);
  bindings.clear("wfb-execution-1");
  assert.ok(bindings.bind("wfb-execution-1", otherAssertion));
});

test("sets an HttpOnly cookie only for the exact BFF-derived origin", () => {
  const parsed = parseTargetAuthExchange(exchangePayload, nowMs);
  assert.ok(parsed);
  assert.equal(
    openedUrlMatchesTargetOrigin(
      `${targetOrigin}/workspaces/default`,
      parsed.targetOrigin,
    ),
    true,
  );
  assert.equal(
    openedUrlMatchesTargetOrigin(
      "http://workflow-builder.workflow-builder.svc.cluster.local:3001/",
      parsed.targetOrigin,
    ),
    false,
  );
  assert.deepEqual(targetAuthCookieToolArguments(parsed), {
    name: WORKFLOW_BUILDER_ACCESS_TOKEN_COOKIE,
    value: "short-lived-owner-cookie",
    url: `${targetOrigin}/`,
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "Strict",
    expires: nowSeconds + 300,
  });
});

test("rejects unsafe or overlong cookie exchanges", () => {
  for (const cookie of [
    { ...exchangePayload.cookie, httpOnly: false },
    { ...exchangePayload.cookie, sameSite: "None" },
    { ...exchangePayload.cookie, expiresAt: nowSeconds + 1_811 },
    { ...exchangePayload.cookie, name: "attacker_cookie" },
  ]) {
    assert.equal(
      parseTargetAuthExchange({ ...exchangePayload, cookie }, nowMs),
      null,
    );
  }
  assert.equal(
    parseTargetAuthExchange(
      { ...exchangePayload, targetOrigin: "http://user:pass@example.test" },
      nowMs,
    ),
    null,
  );
});

test("refreshes the cached cookie before expiry", async () => {
  let currentMs = nowMs;
  let calls = 0;
  const cache = createTargetAuthExchangeCache({
    now: () => currentMs,
    exchange: async () => {
      calls += 1;
      return {
        ...exchangePayload,
        cookie: {
          ...exchangePayload.cookie,
          value: `cookie-${calls}`,
          expiresAt: Math.floor(currentMs / 1_000) + 10 * 60,
        },
      };
    },
  });
  const input = { assertion };
  const first = await cache.resolve("browser-1", input);
  assert.equal(first.cookie.value, "cookie-1");
  currentMs += 4 * 60 * 1_000;
  const cached = await cache.resolve("browser-1", input);
  assert.equal(cached.cookie.value, "cookie-1");
  currentMs += 2 * 60 * 1_000;
  const refreshed = await cache.resolve("browser-1", input);
  assert.equal(refreshed.cookie.value, "cookie-2");
  assert.equal(calls, 2);
});

test("leaves a failed exchange retryable", async () => {
  let calls = 0;
  const cache = createTargetAuthExchangeCache({
    now: () => nowMs,
    exchange: async () => {
      calls += 1;
      return calls === 1 ? null : exchangePayload;
    },
  });
  const input = { assertion };
  assert.equal(await cache.resolve("browser-1", input), null);
  assert.deepEqual(await cache.resolve("browser-1", input), exchangePayload);
  assert.equal(calls, 2);
});

test("never reuses a primed exchange for a missing or different assertion", async () => {
  let calls = 0;
  const cache = createTargetAuthExchangeCache({
    now: () => nowMs,
    exchange: async () => {
      calls += 1;
      return exchangePayload;
    },
  });
  assert.equal(cache.prime("browser-1", { assertion }, exchangePayload), true);
  assert.deepEqual(
    await cache.peek("browser-1", { assertion }),
    exchangePayload,
  );
  assert.equal(await cache.peek("browser-1", { assertion: "" }), null);
  assert.equal(
    await cache.resolve("browser-1", {
      assertion: "wfb_browser_auth_v1.other.signature",
    }),
    null,
  );
  assert.equal(calls, 0);
});
