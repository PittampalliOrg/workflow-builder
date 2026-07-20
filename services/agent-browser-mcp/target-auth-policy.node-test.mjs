import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  authorizeBrowserSessionTermination,
  authorizeBrowserInitialization,
  createTargetAuthExchangeCache,
  exchangeTargetAuth,
  openedUrlMatchesTargetOrigin,
  parseTargetAuthAssertion,
  parseTargetAuthorizationBinding,
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
const rotatedAssertion = "wfb_browser_auth_v1.rotated.signature";
const authorizationBinding =
  "wfb_browser_binding_v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const otherAuthorizationBinding =
  "wfb_browser_binding_v1.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
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

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

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
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "private, no-store",
        },
      });
    },
  });
  assert.deepEqual(result, exchangePayload);
  assert.equal(
    requests[0].url,
    `${targetOrigin}/api/internal/browser-target-auth/exchange`,
  );
  assert.deepEqual(requests[0].init.headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Internal-Token": "internal-service-token",
  });
  assert.equal(requests[0].init.redirect, "error");
  assert.ok(requests[0].init.signal instanceof AbortSignal);
  assert.equal("Authorization" in requests[0].init.headers, false);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    targetAuthAssertion: assertion,
    executionId: "execution-1",
  });
});

test("never forwards the internal token across an exchange redirect", async () => {
  let attackerRequests = 0;
  let leakedToken = null;
  const attacker = createServer((req, res) => {
    attackerRequests += 1;
    leakedToken = req.headers["x-internal-token"] ?? null;
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(exchangePayload));
  });
  const attackerOrigin = await listen(attacker);
  let bffRequests = 0;
  let bffToken = null;
  const redirectingBff = createServer((req, res) => {
    bffRequests += 1;
    bffToken = req.headers["x-internal-token"] ?? null;
    res.writeHead(307, {
      Location: `${attackerOrigin}/steal`,
      "Cache-Control": "no-store",
    });
    res.end();
  });
  const bffOrigin = await listen(redirectingBff);
  try {
    assert.equal(
      await exchangeTargetAuth({
        bffUrl: bffOrigin,
        internalToken: "internal-service-token",
        assertion,
        executionId: "execution-1",
        nowMs,
      }),
      null,
    );
    assert.equal(bffRequests, 1);
    assert.equal(bffToken, "internal-service-token");
    assert.equal(attackerRequests, 0);
    assert.equal(leakedToken, null);
  } finally {
    await Promise.all([closeServer(redirectingBff), closeServer(attacker)]);
  }
});

test("rejects every non-contract exchange response", async () => {
  const validBody = JSON.stringify(exchangePayload);
  const strictHeaders = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  const cases = [
    {
      name: "wrong status",
      response: new Response(validBody, {
        status: 201,
        headers: strictHeaders,
      }),
    },
    {
      name: "wrong content type",
      response: new Response(validBody, {
        status: 200,
        headers: { ...strictHeaders, "Content-Type": "text/html" },
      }),
    },
    {
      name: "cacheable",
      response: new Response(validBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    },
    {
      name: "lookalike cache directive",
      response: new Response(validBody, {
        status: 200,
        headers: { ...strictHeaders, "Cache-Control": "not-no-store" },
      }),
    },
    {
      name: "invalid json",
      response: new Response("{", { status: 200, headers: strictHeaders }),
    },
    {
      name: "extra top-level key",
      response: new Response(
        JSON.stringify({ ...exchangePayload, userId: "user-1" }),
        { status: 200, headers: strictHeaders },
      ),
    },
    {
      name: "extra cookie key",
      response: new Response(
        JSON.stringify({
          ...exchangePayload,
          cookie: { ...exchangePayload.cookie, refreshToken: "must-not-pass" },
        }),
        { status: 200, headers: strictHeaders },
      ),
    },
    {
      name: "oversized",
      response: new Response(JSON.stringify({ padding: "x".repeat(20_000) }), {
        status: 200,
        headers: strictHeaders,
      }),
    },
  ];
  for (const { name, response } of cases) {
    assert.equal(
      await exchangeTargetAuth({
        bffUrl: targetOrigin,
        internalToken: "internal-service-token",
        assertion,
        executionId: "execution-1",
        nowMs,
        fetchImpl: async () => response,
      }),
      null,
      name,
    );
  }
});

test("cancels a chunked exchange body as soon as it exceeds the byte cap", async () => {
  let chunksProduced = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      chunksProduced += 1;
      controller.enqueue(new Uint8Array(4_096));
      if (chunksProduced === 10) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  assert.equal(
    await exchangeTargetAuth({
      bffUrl: targetOrigin,
      internalToken: "internal-service-token",
      assertion,
      executionId: "execution-1",
      nowMs,
      fetchImpl: async () =>
        new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        }),
    }),
    null,
  );
  assert.equal(cancelled, true);
  assert.ok(chunksProduced < 10);
});

test("fails execution initialization closed before browser allocation", async () => {
  const validate = async ({ assertion: supplied, executionId }) =>
    supplied === assertion && executionId === "execution-1"
      ? authorizationBinding
      : null;
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
      validate: async () => authorizationBinding,
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
      authorizationBinding,
    },
  );
});

test("revalidates the exact assertion on every existing-session request", async () => {
  const assertionDigest = targetAuthAssertionDigest(assertion);
  const browserContext = { authorizationBinding };
  const validations = [];
  const authorize = (overrides = {}) =>
    reauthorizeBrowserSession({
      executionId: "execution-1",
      targetAuth: { assertion },
      expectedExecutionId: "execution-1",
      expectedAssertionDigest: assertionDigest,
      expectedAuthorizationBinding: authorizationBinding,
      browserContext,
      isBrowserContextCurrent: (context, binding) =>
        context === browserContext && binding === authorizationBinding,
      validate: async (input) => {
        validations.push(input);
        return authorizationBinding;
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
  assert.equal(
    await authorize({
      validate: async () => otherAuthorizationBinding,
    }),
    false,
  );
  assert.equal(
    await authorize({
      isBrowserContextCurrent: () => false,
    }),
    false,
  );
});

test("fails existing sessions closed when authorization expires or is revoked", async () => {
  const assertionDigest = targetAuthAssertionDigest(assertion);
  const browserContext = { authorizationBinding };
  for (const reason of ["terminal", "revoked", "expired"]) {
    let calls = 0;
    assert.equal(
      await reauthorizeBrowserSession({
        executionId: "execution-1",
        targetAuth: { assertion },
        expectedExecutionId: "execution-1",
        expectedAssertionDigest: assertionDigest,
        expectedAuthorizationBinding: authorizationBinding,
        browserContext,
        isBrowserContextCurrent: () => true,
        validate: async () => {
          calls += 1;
          return null;
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
      expectedAuthorizationBinding: authorizationBinding,
      browserContext,
      isBrowserContextCurrent: () => true,
      validate: async () => {
        throw new Error("BFF unavailable");
      },
    }),
    false,
  );
});

test("authorizes termination for only the exact local MCP capability", () => {
  const input = {
    sessionId: "mcp-session-1",
    executionId: "execution-1",
    targetAuth: { assertion },
    expectedSessionId: "mcp-session-1",
    expectedExecutionId: "execution-1",
    expectedAssertionDigest: targetAuthAssertionDigest(assertion),
  };
  assert.equal(authorizeBrowserSessionTermination(input), true);
  assert.equal(
    authorizeBrowserSessionTermination({
      ...input,
      sessionId: "mcp-session-2",
    }),
    false,
  );
  assert.equal(
    authorizeBrowserSessionTermination({
      ...input,
      executionId: "execution-2",
    }),
    false,
  );
  assert.equal(
    authorizeBrowserSessionTermination({
      ...input,
      targetAuth: { assertion: rotatedAssertion },
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
        return new Response(JSON.stringify({ authorizationBinding }), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "private, no-store",
          },
        });
      },
    }),
    authorizationBinding,
  );
  assert.equal(
    requests[0].url,
    `${targetOrigin}/api/internal/browser-target-auth/validate`,
  );
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    targetAuthAssertion: assertion,
    executionId: "execution-1",
  });
  assert.equal(requests[0].init.redirect, "error");
  assert.ok(requests[0].init.signal instanceof AbortSignal);
  assert.equal(requests[0].init.headers.Accept, "application/json");
  assert.equal("Authorization" in requests[0].init.headers, false);
});

test("rejects redirects and every non-contract validation response", async () => {
  const validBody = JSON.stringify({ authorizationBinding });
  const cases = [
    {
      name: "redirect",
      response: new Response(validBody, {
        status: 302,
        headers: {
          Location: "https://attacker.example/validate",
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      }),
    },
    { name: "empty success", response: new Response(null, { status: 204 }) },
    {
      name: "wrong content type",
      response: new Response(validBody, {
        status: 200,
        headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
      }),
    },
    {
      name: "cacheable response",
      response: new Response(validBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    },
    {
      name: "lookalike cache directive",
      response: new Response(validBody, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "not-no-store",
        },
      }),
    },
    {
      name: "extra fields",
      response: new Response(
        JSON.stringify({ authorizationBinding, executionId: "execution-1" }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
      ),
    },
    {
      name: "malformed binding",
      response: new Response(
        JSON.stringify({ authorizationBinding: "execution-1:user-1" }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
      ),
    },
  ];
  for (const { name, response } of cases) {
    assert.equal(
      await validateTargetAuth({
        bffUrl: targetOrigin,
        internalToken: "internal-service-token",
        assertion,
        executionId: "execution-1",
        fetchImpl: async () => response,
      }),
      null,
      name,
    );
  }
  assert.equal(
    await validateTargetAuth({
      bffUrl: targetOrigin,
      internalToken: "internal-service-token",
      assertion,
      executionId: "execution-1",
      fetchImpl: async () => {
        throw new Error("BFF unavailable");
      },
    }),
    null,
  );
});

test("accepts only opaque authorization binding values", () => {
  assert.equal(
    parseTargetAuthorizationBinding(authorizationBinding),
    authorizationBinding,
  );
  assert.equal(
    parseTargetAuthorizationBinding(` ${authorizationBinding} `),
    null,
  );
  assert.equal(parseTargetAuthorizationBinding("execution-1:user-1"), null);
  assert.equal(
    parseTargetAuthorizationBinding(`${authorizationBinding}.x`),
    null,
  );
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
  const input = { assertion, authorizationBinding };
  const first = await cache.resolve(input);
  assert.equal(first.cookie.value, "cookie-1");
  currentMs += 4 * 60 * 1_000;
  const cached = await cache.resolve({
    assertion: rotatedAssertion,
    authorizationBinding,
  });
  assert.equal(cached.cookie.value, "cookie-1");
  currentMs += 2 * 60 * 1_000;
  const refreshed = await cache.resolve({
    assertion: rotatedAssertion,
    authorizationBinding,
  });
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
  const input = { assertion, authorizationBinding };
  assert.equal(await cache.resolve(input), null);
  assert.deepEqual(await cache.resolve(input), exchangePayload);
  assert.equal(calls, 2);
});

test("reuses a primed exchange only for the same stable authorization binding", async () => {
  let calls = 0;
  const cache = createTargetAuthExchangeCache({
    now: () => nowMs,
    exchange: async () => {
      calls += 1;
      return exchangePayload;
    },
  });
  const input = { assertion, authorizationBinding };
  assert.equal(cache.prime(input, exchangePayload), true);
  assert.deepEqual(
    await cache.peek({ assertion: rotatedAssertion, authorizationBinding }),
    exchangePayload,
  );
  assert.equal(await cache.peek({ assertion, authorizationBinding: "" }), null);
  assert.equal(
    await cache.resolve({
      assertion: rotatedAssertion,
      authorizationBinding: otherAuthorizationBinding,
    }),
    null,
  );
  assert.equal(calls, 0);
});
