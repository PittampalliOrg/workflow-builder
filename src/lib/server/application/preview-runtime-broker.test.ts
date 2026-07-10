import { describe, expect, it, vi } from "vitest";
import type {
  PreviewRuntimeBudgetLimits,
  PreviewRuntimeBudgetReservation,
  PreviewRuntimeBudgetReservationPort,
} from "$lib/server/application/ports";
import {
  ApplicationPreviewRuntimeBrokerService,
  type PreviewRuntimeRequestLimits,
} from "$lib/server/application/preview-runtime-broker";

const identity = Object.freeze({
  previewName: "feature-one",
  environmentRequestId: "request-1",
  environmentPlatformRevision: "a".repeat(40),
  environmentSourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"c".repeat(64)}` as const,
});

const requestLimits: PreviewRuntimeRequestLimits = Object.freeze({
  maxPayloadBytes: 8_192,
  maxMessages: 16,
  maxContentBytes: 4_096,
  maxTools: 8,
  maxToolBytes: 4_096,
  maxCompletionTokens: 512,
  defaultCompletionTokens: 256,
});

const budgetLimits: PreviewRuntimeBudgetLimits = Object.freeze({
  requestsPerMinute: 10,
  reservedTokensPerMinute: 20_000,
  totalRequests: 100,
  totalReservedTokens: 100_000,
});

function harness(
  input: {
    capability?: boolean;
    maxConcurrency?: number;
    requestLimits?: Partial<PreviewRuntimeRequestLimits>;
    budgetLimits?: Partial<PreviewRuntimeBudgetLimits>;
    budgetResult?: PreviewRuntimeBudgetReservation;
    budgetError?: Error;
  } = {},
) {
  const audit = vi.fn();
  const authority = {
    authorizeRuntimeTuple: vi.fn(async () => ({
      previewName: identity.previewName,
      requestId: identity.environmentRequestId,
      owner: "admin-1",
      platformRevision: identity.environmentPlatformRevision as never,
      sourceRevision: identity.environmentSourceRevision as never,
      catalogDigest: identity.catalogDigest,
      services: ["workflow-builder"],
    })),
  };
  const upstream = {
    complete: vi.fn(async () => ({
      status: 200,
      contentType: "application/json",
      requestId: "upstream-1",
      body: null,
    })),
  };
  const reserve = vi.fn(
    async (
      _request: Parameters<PreviewRuntimeBudgetReservationPort["reserve"]>[0],
    ): Promise<PreviewRuntimeBudgetReservation> => {
      if (input.budgetError) throw input.budgetError;
      return (
        input.budgetResult ?? {
          ok: true as const,
          minuteRequests: 1,
          minuteReservedTokens: 512,
          totalRequests: 1,
          totalReservedTokens: 512,
        }
      );
    },
  );
  const budget = { reserve };
  const service = new ApplicationPreviewRuntimeBrokerService({
    authority,
    capabilities: { verify: vi.fn(() => input.capability ?? true) },
    upstream,
    budget,
    budgetLimits: { ...budgetLimits, ...input.budgetLimits },
    requestLimits: { ...requestLimits, ...input.requestLimits },
    allowedModels: ["deepseek-v4-pro"],
    maxConcurrency: input.maxConcurrency ?? 2,
    audit,
  });
  return { service, authority, upstream, budget, audit };
}

const gatewayPayload = Object.freeze({
  model: "deepseek-v4-pro",
  messages: [
    { role: "system", content: "Work only in the preview." },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"README.md"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call-1", content: "preview contents" },
    { role: "user", content: "Continue." },
  ],
  max_tokens: 4_096,
  stream: false,
  tools: [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read one source file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ],
  tool_choice: "auto",
  response_format: { type: "json_object" },
  thinking: { type: "disabled" },
});

const request = {
  identity,
  capability: "d".repeat(64),
  payload: gatewayPayload,
};

describe("preview runtime broker application policy", () => {
  it("rejects a mismatched capability before physical inspection", async () => {
    const h = harness({ capability: false });
    await expect(h.service.complete(request)).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(h.authority.authorizeRuntimeTuple).not.toHaveBeenCalled();
    expect(h.budget.reserve).not.toHaveBeenCalled();
    expect(h.upstream.complete).not.toHaveBeenCalled();
  });

  it("accepts the actual gateway tool-call body and disables thinking exactly", async () => {
    const h = harness();
    await expect(h.service.complete(request)).resolves.toMatchObject({
      status: 200,
    });
    expect(h.upstream.complete).toHaveBeenCalledWith({
      identity,
      payload: { ...gatewayPayload, max_tokens: 512 },
    });
    await expect(
      h.service.complete({
        ...request,
        payload: { ...gatewayPayload, thinking: { type: "enabled" } },
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });
  });

  it("enforces payload, message-content, and tool shape/size bounds", async () => {
    const oversized = harness({ requestLimits: { maxPayloadBytes: 1_024 } });
    await expect(
      oversized.service.complete({
        ...request,
        payload: {
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "x".repeat(2_000) }],
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });

    const contentBound = harness({ requestLimits: { maxContentBytes: 100 } });
    const toolBound = harness({
      requestLimits: { maxContentBytes: 512, maxToolBytes: 256 },
    });
    await expect(
      contentBound.service.complete({
        ...request,
        payload: {
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "x".repeat(101) }],
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    await expect(
      toolBound.service.complete({
        ...request,
        payload: {
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "hello" }],
          tools: [
            {
              type: "function",
              function: {
                name: "read_file",
                description: "x".repeat(240),
                parameters: { type: "object", properties: {} },
              },
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });

    const h = harness();
    for (const payload of [
      {
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: 42 }],
      },
      {
        model: "deepseek-v4-pro",
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://x" } }],
          },
        ],
      },
      {
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "read_file" } }],
      },
      {
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hello" }],
        unknown_provider_escape: true,
      },
    ]) {
      await expect(
        h.service.complete({ ...request, payload }),
      ).rejects.toMatchObject({ code: "invalid-request" });
    }
    expect(h.authority.authorizeRuntimeTuple).not.toHaveBeenCalled();
  });

  it("clamps output tokens, defaults safely, and rejects ambiguous fan-out", async () => {
    const h = harness({
      requestLimits: {
        maxCompletionTokens: 128,
        defaultCompletionTokens: 128,
      },
    });
    await h.service.complete({
      ...request,
      payload: {
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 9_999,
        n: 1,
        best_of: 1,
      },
    });
    expect(h.upstream.complete).toHaveBeenLastCalledWith({
      identity,
      payload: expect.objectContaining({ max_tokens: 128, n: 1, best_of: 1 }),
    });
    expect(h.budget.reserve.mock.calls[0][0].reservedTokens).toBeGreaterThan(
      128,
    );

    const defaults = harness({
      requestLimits: { maxCompletionTokens: 512, defaultCompletionTokens: 192 },
    });
    await defaults.service.complete({
      ...request,
      payload: {
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(defaults.upstream.complete).toHaveBeenCalledWith({
      identity,
      payload: expect.objectContaining({ max_completion_tokens: 192 }),
    });

    for (const patch of [
      { max_tokens: 0 },
      { max_tokens: 2, max_completion_tokens: 2 },
      { n: 2 },
      { best_of: 2 },
    ]) {
      await expect(
        h.service.complete({
          ...request,
          payload: {
            model: "deepseek-v4-pro",
            messages: [{ role: "user", content: "hello" }],
            ...patch,
          },
        }),
      ).rejects.toMatchObject({ code: "invalid-request" });
    }
  });

  it("authorizes then reserves the exact one-service identity before upstream", async () => {
    const h = harness();
    await h.service.complete(request);
    expect(h.authority.authorizeRuntimeTuple).toHaveBeenCalledWith(identity);
    expect(h.budget.reserve).toHaveBeenCalledWith({
      identity,
      reservedTokens: expect.any(Number),
      limits: budgetLimits,
    });
    expect(
      h.authority.authorizeRuntimeTuple.mock.invocationCallOrder[0],
    ).toBeLessThan(h.budget.reserve.mock.invocationCallOrder[0]);
    expect(h.budget.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      h.upstream.complete.mock.invocationCallOrder[0],
    );
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(
      "preview contents",
    );
  });

  it("never reserves when exact tuple authorization fails", async () => {
    const h = harness();
    h.authority.authorizeRuntimeTuple.mockRejectedValueOnce(
      new Error("tuple drift"),
    );
    await expect(h.service.complete(request)).rejects.toThrow("tuple drift");
    expect(h.budget.reserve).not.toHaveBeenCalled();
    expect(h.upstream.complete).not.toHaveBeenCalled();
  });

  it("fails closed with distinct exhausted and unavailable budget errors", async () => {
    const denied = harness({
      budgetResult: { ok: false, reason: "minute-token-limit" },
    });
    await expect(denied.service.complete(request)).rejects.toMatchObject({
      code: "budget-exhausted",
      budgetReason: "minute-token-limit",
    });
    expect(denied.upstream.complete).not.toHaveBeenCalled();
    expect(denied.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "budget-denied",
        budgetReason: "minute-token-limit",
      }),
    );

    const unavailable = harness({ budgetError: new Error("postgres down") });
    await expect(unavailable.service.complete(request)).rejects.toMatchObject({
      code: "budget-unavailable",
    });
    expect(unavailable.upstream.complete).not.toHaveBeenCalled();
  });

  it("does not refund a reservation when the upstream fails", async () => {
    const h = harness();
    h.upstream.complete.mockRejectedValueOnce(new Error("gateway failed"));
    await expect(h.service.complete(request)).rejects.toThrow("gateway failed");
    expect(h.budget.reserve).toHaveBeenCalledOnce();
  });

  it("bounds in-process concurrency in addition to the distributed budget", async () => {
    const h = harness({ maxConcurrency: 1 });
    let release!: () => void;
    h.upstream.complete.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              status: 200,
              contentType: "application/json",
              requestId: "upstream-2",
              body: null,
            });
        }),
    );
    const first = h.service.complete(request);
    await vi.waitFor(() => expect(h.upstream.complete).toHaveBeenCalledOnce());
    await expect(h.service.complete(request)).rejects.toMatchObject({
      code: "capacity",
    });
    release();
    await first;
  });
});
