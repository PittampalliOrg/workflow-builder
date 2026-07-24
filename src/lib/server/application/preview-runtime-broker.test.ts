import { describe, expect, it, vi } from "vitest";
import type {
  PreviewRuntimeBudgetLimits,
  PreviewRuntimeBudgetReservation,
  PreviewRuntimeBudgetReservationPort,
  PreviewRuntimeCompletionResponse,
} from "$lib/server/application/ports";
import {
  ApplicationPreviewRuntimeBrokerService,
  KIMI_K3_CONTEXT_TOKENS,
  KIMI_K3_MAX_COMPLETION_TOKENS,
  PREVIEW_RUNTIME_ABSOLUTE_MAX_PAYLOAD_BYTES,
  PREVIEW_RUNTIME_DEFAULT_MAX_PAYLOAD_BYTES,
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
    now?: () => number;
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
    complete: vi.fn(
      async (): Promise<PreviewRuntimeCompletionResponse> => ({
        status: 200,
        contentType: "application/json",
        requestId: "upstream-1",
        body: null,
      }),
    ),
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
    allowedModels: ["deepseek-v4-pro", "kimi-k3"],
    maxConcurrency: input.maxConcurrency ?? 2,
    audit,
    now: input.now,
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

const streamingRequest = {
  ...request,
  payload: { ...gatewayPayload, stream: true },
};

function sseResponse(body: ReadableStream<Uint8Array>) {
  return {
    status: 200,
    contentType: "text/event-stream; charset=utf-8",
    requestId: "upstream-stream-1",
    body,
  };
}

async function expectExactlyOneCapacitySlot(
  h: ReturnType<typeof harness>,
): Promise<void> {
  const callsBeforeProbe = h.upstream.complete.mock.calls.length;
  let releaseProbe!: () => void;
  h.upstream.complete.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseProbe = () =>
          resolve({
            status: 200,
            contentType: "application/json",
            requestId: "upstream-probe",
            body: null,
          });
      }),
  );
  const occupying = h.service.complete(request);
  await vi.waitFor(() =>
    expect(h.upstream.complete).toHaveBeenCalledTimes(callsBeforeProbe + 1),
  );
  try {
    await expect(h.service.complete(request)).rejects.toMatchObject({
      code: "capacity",
    });
  } finally {
    releaseProbe();
    await occupying;
  }
}

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

  it("preserves supported Kimi K3 effort and bounded assistant reasoning", async () => {
    const h = harness();
    const kimiPayload = {
      model: "kimi-k3",
      messages: [
        { role: "user", content: "Read the file." },
        {
          role: "assistant",
          content: "",
          reasoning_content: "I should inspect README.md.\nThen continue.",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: "contents" },
      ],
      max_completion_tokens: 131_072,
      reasoning_effort: "low",
    };

    await expect(
      h.service.complete({ ...request, payload: kimiPayload }),
    ).resolves.toMatchObject({ status: 200 });
    expect(h.upstream.complete).toHaveBeenCalledWith({
      identity,
      payload: {
        ...kimiPayload,
        max_completion_tokens: 512,
        reasoning_effort: "low",
      },
    });

    for (const reasoning_effort of ["high", "max"]) {
      await h.service.complete({
        ...request,
        payload: { ...kimiPayload, reasoning_effort },
      });
      expect(h.upstream.complete).toHaveBeenLastCalledWith({
        identity,
        payload: {
          ...kimiPayload,
          reasoning_effort,
          max_completion_tokens: 512,
        },
      });
    }

    const { reasoning_effort: _reasoningEffort, ...kimiWithoutReasoning } =
      kimiPayload;
    const withoutReasoning = {
      ...kimiWithoutReasoning,
      max_completion_tokens: 256,
    };
    await h.service.complete({ ...request, payload: withoutReasoning });
    expect(h.upstream.complete).toHaveBeenLastCalledWith({
      identity,
      payload: {
        ...withoutReasoning,
        max_completion_tokens: 256,
        reasoning_effort: "max",
      },
    });

    await expect(
      h.service.complete({
        ...request,
        payload: { ...kimiPayload, reasoning_effort: "medium" },
      }),
    ).rejects.toMatchObject({
      code: "invalid-request",
      message: "kimi-k3 reasoning_effort must be low, high, or max",
    });

    for (const payload of [
      { ...kimiPayload, reasoning_effort: "xhigh" },
      { ...kimiPayload, reasoning_effort: "ultra" },
      { ...kimiPayload, thinking: { type: "disabled" } },
      {
        ...kimiPayload,
        messages: [
          { role: "user", content: "hello", reasoning_content: "not allowed" },
        ],
      },
      {
        ...kimiPayload,
        messages: [
          {
            role: "assistant",
            content: "done",
            reasoning_content: "x".repeat(requestLimits.maxContentBytes + 1),
          },
        ],
      },
    ]) {
      await expect(
        h.service.complete({ ...request, payload }),
      ).rejects.toMatchObject({ code: "invalid-request" });
    }
  });

  it("admits the full Kimi K3 completion budget when configured", async () => {
    const h = harness({
      requestLimits: {
        maxPayloadBytes: 2_000_000,
        maxContentBytes: 1_100_000,
        maxCompletionTokens: KIMI_K3_MAX_COMPLETION_TOKENS,
        defaultCompletionTokens: KIMI_K3_MAX_COMPLETION_TOKENS,
      },
      budgetLimits: {
        reservedTokensPerMinute: 2_000_000,
        totalReservedTokens: 4_000_000,
      },
    });
    const content = "x".repeat(KIMI_K3_CONTEXT_TOKENS);

    await h.service.complete({
      ...request,
      payload: {
        model: "kimi-k3",
        messages: [{ role: "user", content }],
      },
    });

    expect(h.upstream.complete).toHaveBeenCalledWith({
      identity,
      payload: {
        model: "kimi-k3",
        messages: [{ role: "user", content }],
        max_completion_tokens: KIMI_K3_MAX_COMPLETION_TOKENS,
        reasoning_effort: "max",
      },
    });
    expect(h.budget.reserve).toHaveBeenCalledWith({
      identity,
      reservedTokens: expect.any(Number),
      limits: {
        ...budgetLimits,
        reservedTokensPerMinute: 2_000_000,
        totalReservedTokens: 4_000_000,
      },
    });
    expect(h.budget.reserve.mock.calls[0][0].reservedTokens).toBeGreaterThan(
      KIMI_K3_CONTEXT_TOKENS + KIMI_K3_MAX_COMPLETION_TOKENS,
    );
    expect(h.budget.reserve.mock.calls[0][0].reservedTokens).toBeLessThan(
      2_000_000,
    );
  });

  it("never forwards a Kimi K3 completion budget above its model limit", async () => {
    const h = harness({
      requestLimits: {
        maxCompletionTokens: 200_000,
        defaultCompletionTokens: 150_000,
      },
      budgetLimits: {
        reservedTokensPerMinute: 500_000,
        totalReservedTokens: 1_000_000,
      },
    });

    await h.service.complete({
      ...request,
      payload: {
        model: "kimi-k3",
        messages: [{ role: "user", content: "hello" }],
        max_completion_tokens: 200_000,
      },
    });

    expect(h.upstream.complete).toHaveBeenCalledWith({
      identity,
      payload: expect.objectContaining({
        max_completion_tokens: KIMI_K3_MAX_COMPLETION_TOKENS,
        reasoning_effort: "max",
      }),
    });
  });

  it("keeps the Kimi context transport bound below BODY_SIZE_LIMIT=25M", () => {
    expect(PREVIEW_RUNTIME_DEFAULT_MAX_PAYLOAD_BYTES).toBe(16_777_216);
    expect(PREVIEW_RUNTIME_ABSOLUTE_MAX_PAYLOAD_BYTES).toBe(24_000_000);
    expect(PREVIEW_RUNTIME_ABSOLUTE_MAX_PAYLOAD_BYTES).toBeLessThan(25_000_000);
  });

  it("forwards bounded Kimi image_url data parts without stringifying pixels", async () => {
    const h = harness();
    const imageUrl = "data:image/png;base64,iVBORw0KGgo=";
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this screenshot." },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ];

    await h.service.complete({
      ...request,
      payload: { model: "kimi-k3", messages },
    });

    expect(h.upstream.complete).toHaveBeenCalledWith({
      identity,
      payload: {
        model: "kimi-k3",
        messages,
        max_completion_tokens: requestLimits.defaultCompletionTokens,
        reasoning_effort: "max",
      },
    });
  });

  it.each([
    [
      "public URL",
      {
        type: "image_url",
        image_url: { url: "https://example.com/ui.png" },
      },
    ],
    [
      "unsupported media type",
      {
        type: "image_url",
        image_url: { url: "data:image/svg+xml;base64,PHN2Zz4=" },
      },
    ],
    [
      "non-base64 data URI",
      { type: "image_url", image_url: { url: "data:image/png,raw" } },
    ],
    [
      "invalid base64",
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,!!!!" },
      },
    ],
    [
      "non-canonical base64",
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AB==" },
      },
    ],
    [
      "string image_url",
      { type: "image_url", image_url: "data:image/png;base64,AAAA" },
    ],
    [
      "extra image fields",
      {
        type: "image_url",
        image_url: {
          url: "data:image/png;base64,AAAA",
          detail: "auto",
        },
      },
    ],
    [
      "video part",
      {
        type: "video_url",
        video_url: { url: "data:video/mp4;base64,AAAA" },
      },
    ],
  ])(
    "rejects malformed or unsupported multimodal content: %s",
    async (_case, part) => {
      const h = harness();

      await expect(
        h.service.complete({
          ...request,
          payload: {
            model: "kimi-k3",
            messages: [{ role: "user", content: [part] }],
          },
        }),
      ).rejects.toMatchObject({ code: "invalid-request" });
      expect(h.authority.authorizeRuntimeTuple).not.toHaveBeenCalled();
      expect(h.upstream.complete).not.toHaveBeenCalled();
    },
  );

  it("rejects image_url content outside user messages", async () => {
    const h = harness();

    await expect(
      h.service.complete({
        ...request,
        payload: {
          model: "kimi-k3",
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "image_url",
                  image_url: { url: "data:image/png;base64,AAAA" },
                },
              ],
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(h.authority.authorizeRuntimeTuple).not.toHaveBeenCalled();
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
      budgetResult: {
        ok: false,
        reason: "minute-token-limit",
        retryAfterSeconds: 17,
      },
    });
    await expect(denied.service.complete(request)).rejects.toMatchObject({
      code: "budget-exhausted",
      budgetReason: "minute-token-limit",
      retryAfterSeconds: 17,
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

  it("holds capacity and terminal audit until an SSE body closes", async () => {
    let currentTime = 1_000;
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    const sourcePull = vi.fn();
    const upstreamBody = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          sourceController = controller;
        },
        pull() {
          sourcePull();
        },
      },
      { highWaterMark: 0 },
    );
    const h = harness({
      maxConcurrency: 1,
      now: () => currentTime,
    });
    h.upstream.complete.mockResolvedValueOnce(sseResponse(upstreamBody));

    const response = await h.service.complete(streamingRequest);
    expect(sourcePull).not.toHaveBeenCalled();
    expect(h.audit.mock.calls.map(([record]) => record.status)).toEqual([
      "accepted",
    ]);
    await expect(h.service.complete(request)).rejects.toMatchObject({
      code: "capacity",
    });

    const reader = response.body!.getReader();
    const firstRead = reader.read();
    await vi.waitFor(() => expect(sourcePull).toHaveBeenCalledOnce());
    const chunk = new TextEncoder().encode('data: {"id":"chunk-1"}\n\n');
    sourceController.enqueue(chunk);
    await expect(firstRead).resolves.toEqual({ done: false, value: chunk });
    expect(sourcePull).toHaveBeenCalledOnce();

    const finalRead = reader.read();
    await vi.waitFor(() => expect(sourcePull).toHaveBeenCalledTimes(2));
    currentTime = 1_450;
    sourceController.close();
    await expect(finalRead).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(
      h.audit.mock.calls
        .map(([record]) => record)
        .filter((record) => record.status !== "accepted"),
    ).toEqual([
      expect.objectContaining({
        status: "completed",
        upstreamStatus: 200,
        durationMs: 450,
      }),
    ]);

    await expectExactlyOneCapacitySlot(h);
  });

  it("cancels an open SSE upstream and finalizes its audit once", async () => {
    let currentTime = 2_000;
    const sourcePull = vi.fn();
    const sourceCancel = vi.fn();
    const upstreamBody = new ReadableStream<Uint8Array>(
      {
        pull() {
          sourcePull();
        },
        cancel(reason) {
          sourceCancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    const h = harness({
      maxConcurrency: 1,
      now: () => currentTime,
    });
    h.upstream.complete.mockResolvedValueOnce(sseResponse(upstreamBody));

    const response = await h.service.complete(streamingRequest);
    const reader = response.body!.getReader();
    const pendingRead = reader.read();
    await vi.waitFor(() => expect(sourcePull).toHaveBeenCalledOnce());
    await expect(h.service.complete(request)).rejects.toMatchObject({
      code: "capacity",
    });

    currentTime = 2_300;
    await reader.cancel("downstream disconnected");
    await expect(pendingRead).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(sourceCancel).toHaveBeenCalledOnce();
    expect(sourceCancel).toHaveBeenCalledWith("downstream disconnected");
    expect(
      h.audit.mock.calls
        .map(([record]) => record)
        .filter((record) => record.status !== "accepted"),
    ).toEqual([
      expect.objectContaining({
        status: "completed",
        upstreamStatus: 200,
        durationMs: 300,
      }),
    ]);

    await expectExactlyOneCapacitySlot(h);
  });

  it("propagates an SSE read error and releases capacity exactly once", async () => {
    let currentTime = 3_000;
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    const sourcePull = vi.fn();
    const upstreamBody = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          sourceController = controller;
        },
        pull() {
          sourcePull();
        },
      },
      { highWaterMark: 0 },
    );
    const h = harness({
      maxConcurrency: 1,
      now: () => currentTime,
    });
    h.upstream.complete.mockResolvedValueOnce(sseResponse(upstreamBody));

    const response = await h.service.complete(streamingRequest);
    const reader = response.body!.getReader();
    const pendingRead = reader.read();
    await vi.waitFor(() => expect(sourcePull).toHaveBeenCalledOnce());
    await expect(h.service.complete(request)).rejects.toMatchObject({
      code: "capacity",
    });

    currentTime = 3_125;
    const upstreamError = new Error("upstream SSE failed");
    sourceController.error(upstreamError);
    await expect(pendingRead).rejects.toBe(upstreamError);
    expect(
      h.audit.mock.calls
        .map(([record]) => record)
        .filter((record) => record.status !== "accepted"),
    ).toEqual([
      expect.objectContaining({
        status: "failed",
        upstreamStatus: 200,
        durationMs: 125,
      }),
    ]);

    await expectExactlyOneCapacitySlot(h);
  });

  it("keeps non-streaming responses on immediate terminal accounting", async () => {
    let currentTime = 4_000;
    const sourceCancel = vi.fn();
    const jsonBody = new ReadableStream<Uint8Array>({
      cancel(reason) {
        sourceCancel(reason);
      },
    });
    const h = harness({
      maxConcurrency: 1,
      now: () => currentTime,
    });
    h.upstream.complete.mockImplementationOnce(async () => {
      currentTime = 4_025;
      return {
        status: 200,
        contentType: "application/json",
        requestId: "upstream-json-1",
        body: jsonBody,
      };
    });

    const response = await h.service.complete(request);
    expect(
      h.audit.mock.calls
        .map(([record]) => record)
        .filter((record) => record.status !== "accepted"),
    ).toEqual([
      expect.objectContaining({
        status: "completed",
        upstreamStatus: 200,
        durationMs: 25,
      }),
    ]);
    await expect(h.service.complete(request)).resolves.toMatchObject({
      status: 200,
    });
    await response.body?.cancel("test cleanup");
    expect(sourceCancel).toHaveBeenCalledWith("test cleanup");
    expect(
      h.audit.mock.calls.filter(
        ([record]) =>
          record.requestId === identity.environmentRequestId &&
          record.status === "completed",
      ),
    ).toHaveLength(2);
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
