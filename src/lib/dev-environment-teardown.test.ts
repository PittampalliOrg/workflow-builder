import { describe, expect, it, vi } from "vitest";
import {
  DevEnvironmentTeardownBlockedError,
  teardownDevEnvironmentUntilComplete,
} from "./dev-environment-teardown";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("teardownDevEnvironmentUntilComplete", () => {
  it("returns only after a later DELETE proves completion", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            ok: true,
            complete: false,
            pending: true,
            executionId: "exec/one",
          },
          202,
        ),
      )
      .mockResolvedValueOnce(
        json(
          {
            ok: true,
            complete: true,
            pending: false,
            executionId: "exec/one",
          },
          200,
        ),
      );
    const sleep = vi.fn(async () => undefined);

    await expect(
      teardownDevEnvironmentUntilComplete("exec/one", { fetcher, sleep }),
    ).resolves.toEqual({ ok: true, complete: true, pending: false });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/dev-environments/exec%2Fone",
      "/api/dev-environments/exec%2Fone",
    ]);
    expect(
      fetcher.mock.calls.every(([, init]) => init?.method === "DELETE"),
    ).toBe(true);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("accepts an immediate exact completion receipt without sleeping", async () => {
    const fetcher = vi.fn(async () =>
      json(
        {
          ok: true,
          complete: true,
          pending: false,
          executionId: "exec-1",
        },
        200,
      ),
    );
    const sleep = vi.fn(async () => undefined);

    await expect(
      teardownDevEnvironmentUntilComplete("exec-1", { fetcher, sleep }),
    ).resolves.toEqual({ ok: true, complete: true, pending: false });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("sends the explicit admin discard flag on every teardown retry", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            ok: true,
            complete: false,
            pending: true,
            executionId: "exec-1",
          },
          202,
        ),
      )
      .mockResolvedValueOnce(
        json(
          {
            ok: true,
            complete: true,
            pending: false,
            executionId: "exec-1",
          },
          200,
        ),
      );

    await teardownDevEnvironmentUntilComplete("exec-1", {
      fetcher,
      sleep: vi.fn(async () => undefined),
      discardUncaptured: true,
    });

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/dev-environments/exec-1?discardUncaptured=true",
      "/api/dev-environments/exec-1?discardUncaptured=true",
    ]);
  });

  it("surfaces a capture-blocked 409 using the server-provided reason", async () => {
    const fetcher = vi.fn(async () =>
      json(
        {
          ok: false,
          complete: false,
          pending: false,
          executionId: "exec-1",
          error: "Capture receiver is unavailable; teardown was not started",
        },
        409,
      ),
    );

    const promise = teardownDevEnvironmentUntilComplete("exec-1", {
      fetcher,
      sleep: vi.fn(),
    });

    await expect(promise).rejects.toMatchObject({
      name: "DevEnvironmentTeardownBlockedError",
      status: 409,
      message: "Capture receiver is unavailable; teardown was not started",
    } satisfies Partial<DevEnvironmentTeardownBlockedError>);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("surfaces an authorization failure before retrying teardown", async () => {
    const fetcher = vi.fn(async () =>
      json(
        {
          ok: false,
          complete: false,
          pending: false,
          executionId: "exec-1",
          error: "Checkpoint-preserving preview teardown requires a platform administrator",
        },
        403,
      ),
    );

    await expect(
      teardownDevEnvironmentUntilComplete("exec-1", { fetcher }),
    ).rejects.toThrow("requires a platform administrator");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("fails immediately on an explicit semantic 503 receipt", async () => {
    const fetcher = vi.fn(async () =>
      json(
        {
          ok: false,
          complete: false,
          pending: false,
          executionId: "exec-1",
        },
        503,
      ),
    );
    const sleep = vi.fn(async () => undefined);

    await expect(
      teardownDevEnvironmentUntilComplete("exec-1", { fetcher, sleep }),
    ).rejects.toThrow("Teardown failed (503)");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails immediately when a semantic 503 also has deferred cleanup", async () => {
    const fetcher = vi.fn(async () =>
      json(
        {
          ok: false,
          complete: false,
          pending: true,
          executionId: "exec-1",
        },
        503,
      ),
    );
    const sleep = vi.fn(async () => undefined);

    await expect(
      teardownDevEnvironmentUntilComplete("exec-1", { fetcher, sleep }),
    ).rejects.toThrow("Teardown failed (503)");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries transport failures within the teardown deadline", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network disconnected"))
      .mockResolvedValueOnce(
        json(
          {
            ok: true,
            complete: true,
            pending: false,
            executionId: "exec-1",
          },
          200,
        ),
      );
    const sleep = vi.fn(async () => undefined);

    await expect(
      teardownDevEnvironmentUntilComplete("exec-1", { fetcher, sleep }),
    ).resolves.toEqual({ ok: true, complete: true, pending: false });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("retries transient 502, non-semantic 503, and 504 responses", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(json({ detail: "service restarting" }, 503))
      .mockResolvedValueOnce(new Response(null, { status: 504 }))
      .mockResolvedValueOnce(
        json(
          {
            ok: true,
            complete: true,
            pending: false,
            executionId: "exec-1",
          },
          200,
        ),
      );
    const sleep = vi.fn(async () => undefined);

    await expect(
      teardownDevEnvironmentUntilComplete("exec-1", { fetcher, sleep }),
    ).resolves.toEqual({ ok: true, complete: true, pending: false });

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("bounds repeated transport retries by the configured timeout", async () => {
    let now = 1_000;
    const fetcher = vi.fn(async () => {
      throw new TypeError("network disconnected");
    });
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });

    await expect(
      teardownDevEnvironmentUntilComplete("exec-1", {
        fetcher,
        sleep,
        now: () => now,
        timeoutMs: 2_500,
        retryIntervalMs: 1_000,
      }),
    ).rejects.toThrow(
      "Teardown timed out while waiting for response-path cleanup",
    );

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      1_000, 1_000, 500,
    ]);
  });

  it("keeps the deadline active while reading the response receipt", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          const signal = init?.signal;
          return {
            status: 200,
            json: () =>
              new Promise((_resolve, reject) => {
                signal?.addEventListener(
                  "abort",
                  () => reject(new Error("aborted")),
                  {
                    once: true,
                  },
                );
              }),
          } as Response;
        },
      );
      const pending = teardownDevEnvironmentUntilComplete("exec-1", {
        fetcher,
        timeoutMs: 100,
      });
      const rejected = expect(pending).rejects.toThrow(
        "Teardown timed out while waiting for response-path cleanup",
      );

      await vi.advanceTimersByTimeAsync(100);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [202, { ok: true, complete: true, pending: false }],
    [200, { ok: true, complete: false, pending: true }],
    [200, { ok: false, complete: true, pending: false }],
    [202, { ok: true, complete: false }],
    [
      200,
      {
        ok: true,
        complete: true,
        pending: false,
        executionId: "other-execution",
      },
    ],
  ])(
    "rejects a malformed status/receipt pair for HTTP %s",
    async (status, body) => {
      const fetcher = vi.fn(async () => json(body, status));

      await expect(
        teardownDevEnvironmentUntilComplete("exec-1", {
          fetcher,
          sleep: vi.fn(),
        }),
      ).rejects.toThrow(`Teardown returned an invalid receipt (${status})`);
    },
  );

  it.each([200, 202])(
    "replays an exact DELETE after a truncated HTTP %s receipt",
    async (lostStatus) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          new Response("truncated", { status: lostStatus }),
        )
        .mockResolvedValueOnce(
          json(
            {
              ok: true,
              complete: true,
              pending: false,
              executionId: "exec-1",
            },
            200,
          ),
        );
      const sleep = vi.fn(async () => undefined);

      await expect(
        teardownDevEnvironmentUntilComplete("exec-1", {
          fetcher,
          sleep,
        }),
      ).resolves.toEqual({ ok: true, complete: true, pending: false });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledOnce();
    },
  );

  it("bounds retries by the configured timeout", async () => {
    let now = 1_000;
    const fetcher = vi.fn(async () =>
      json(
        {
          ok: true,
          complete: false,
          pending: true,
          executionId: "exec-1",
        },
        202,
      ),
    );
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });

    await expect(
      teardownDevEnvironmentUntilComplete("exec-1", {
        fetcher,
        sleep,
        now: () => now,
        timeoutMs: 2_500,
        retryIntervalMs: 1_000,
      }),
    ).rejects.toThrow(
      "Teardown timed out while waiting for response-path cleanup",
    );

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      1_000, 1_000, 500,
    ]);
  });
});
