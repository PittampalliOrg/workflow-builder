import test from "node:test";
import assert from "node:assert/strict";
import {
  createTargetAuthExchangeCache,
  exchangeTargetAuth,
  openedUrlMatchesTargetOrigin,
  parseTargetAuthAssertion,
  parseTargetAuthExchange,
  targetAuthCookieToolArguments,
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
  const first = await cache.resolve("browser-1", {});
  assert.equal(first.cookie.value, "cookie-1");
  currentMs += 4 * 60 * 1_000;
  const cached = await cache.resolve("browser-1", {});
  assert.equal(cached.cookie.value, "cookie-1");
  currentMs += 2 * 60 * 1_000;
  const refreshed = await cache.resolve("browser-1", {});
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
  assert.equal(await cache.resolve("browser-1", {}), null);
  assert.deepEqual(await cache.resolve("browser-1", {}), exchangePayload);
  assert.equal(calls, 2);
});
