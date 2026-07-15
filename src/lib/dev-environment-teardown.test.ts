import { describe, expect, it, vi } from "vitest";
import {
  DevEnvironmentTeardownBlockedError,
  pendingDevEnvironmentTeardowns,
  teardownDevEnvironmentUntilComplete,
  type DevEnvironmentTeardownProgress,
  type DevEnvironmentTeardownStorage,
} from "./dev-environment-teardown";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

class MemoryStorage implements DevEnvironmentTeardownStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
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
    const progress: DevEnvironmentTeardownProgress[] = [];

    await expect(
      teardownDevEnvironmentUntilComplete("exec/one", {
        fetcher,
        sleep,
        onProgress: (phase) => progress.push(phase),
      }),
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
    expect(progress).toEqual(["submitting", "pending", "complete"]);
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

    const storage = new MemoryStorage();
    const promise = teardownDevEnvironmentUntilComplete("exec-1", {
      fetcher,
      sleep: vi.fn(),
      storage,
    });

    await expect(promise).rejects.toMatchObject({
      name: "DevEnvironmentTeardownBlockedError",
      status: 409,
      message: "Capture receiver is unavailable; teardown was not started",
    } satisfies Partial<DevEnvironmentTeardownBlockedError>);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(pendingDevEnvironmentTeardowns({ storage })).toEqual([]);
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

  it("reconciles an application 503 after preview removal", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            ok: false,
            complete: false,
            pending: false,
            executionId: "exec-1",
            error: "lifecycle cleanup failed",
          },
          503,
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
    const sleep = vi.fn(async () => undefined);
    const progress: DevEnvironmentTeardownProgress[] = [];
    const storage = new MemoryStorage();

    await expect(
      teardownDevEnvironmentUntilComplete("exec-1", {
        fetcher,
        sleep,
        storage,
        onProgress: (phase) => progress.push(phase),
      }),
    ).resolves.toEqual({ ok: true, complete: true, pending: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(progress).toEqual(["submitting", "reconciling", "complete"]);
    expect(pendingDevEnvironmentTeardowns({ storage })).toEqual([]);
  });

  it("retains recovery state while a partial-cleanup 503 cannot converge", async () => {
    let now = 1_000;
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
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const storage = new MemoryStorage();

    await expect(
      teardownDevEnvironmentUntilComplete("exec-1", {
        fetcher,
        sleep,
        now: () => now,
        storage,
        timeoutMs: 2_500,
        retryIntervalMs: 1_000,
      }),
    ).rejects.toThrow("Teardown could not yet be confirmed");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(pendingDevEnvironmentTeardowns({ storage, now: () => now })).toEqual([
      {
        executionId: "exec-1",
        discardUncaptured: false,
        startedAt: 1_000,
      },
    ]);
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
    const progress: DevEnvironmentTeardownProgress[] = [];
    const storage = new MemoryStorage();

    await expect(
      teardownDevEnvironmentUntilComplete("exec-1", {
        fetcher,
        sleep,
        storage,
        onProgress: (phase) => progress.push(phase),
      }),
    ).resolves.toEqual({ ok: true, complete: true, pending: false });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(progress).toEqual(["submitting", "reconciling", "complete"]);
    expect(pendingDevEnvironmentTeardowns({ storage })).toEqual([]);
  });

  it("retains the exact recovery marker when a semantic response follows an uncertain submit", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network disconnected"))
      .mockResolvedValueOnce(
        json(
          {
            ok: false,
            complete: false,
            pending: false,
            executionId: "exec-1",
            error: "Teardown is already in progress",
          },
          409,
        ),
      );
    const storage = new MemoryStorage();

    await expect(
      teardownDevEnvironmentUntilComplete("exec-1", {
        fetcher,
        sleep: vi.fn(async () => undefined),
        now: () => 1_000,
        storage,
      }),
    ).rejects.toThrow("Teardown is already in progress");

    expect(pendingDevEnvironmentTeardowns({ storage, now: () => 1_000 })).toEqual([
      {
        executionId: "exec-1",
        discardUncaptured: false,
        startedAt: 1_000,
      },
    ]);
  });

  it("retries ambiguous timeout, throttle, and gateway responses", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ detail: "request timeout" }, 408))
      .mockResolvedValueOnce(json({ detail: "too early" }, 425))
      .mockResolvedValueOnce(json({ detail: "rate limited" }, 429))
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

    expect(fetcher).toHaveBeenCalledTimes(7);
    expect(sleep).toHaveBeenCalledTimes(6);
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
      "Teardown could not yet be confirmed",
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
        "Teardown could not yet be confirmed",
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
    "replays a parseable but invalid HTTP %s success receipt",
    async (status, body) => {
      const storage = new MemoryStorage();
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(json(body, status))
        .mockImplementationOnce(async () => {
          expect(pendingDevEnvironmentTeardowns({ storage })).toEqual([
            expect.objectContaining({ executionId: "exec-1" }),
          ]);
          return json(
            {
              ok: true,
              complete: true,
              pending: false,
              executionId: "exec-1",
            },
            200,
          );
        });

      await expect(
        teardownDevEnvironmentUntilComplete("exec-1", {
          fetcher,
          sleep: vi.fn(async () => undefined),
          storage,
        }),
      ).resolves.toEqual({ ok: true, complete: true, pending: false });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(pendingDevEnvironmentTeardowns({ storage })).toEqual([]);
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
    const storage = new MemoryStorage();

    await expect(
      teardownDevEnvironmentUntilComplete("exec-1", {
        fetcher,
        sleep,
        now: () => now,
        storage,
        discardUncaptured: true,
        timeoutMs: 2_500,
        retryIntervalMs: 1_000,
      }),
    ).rejects.toThrow(
      "Teardown could not yet be confirmed",
    );

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      1_000, 1_000, 500,
    ]);
    expect(
      pendingDevEnvironmentTeardowns({ storage, now: () => now }),
    ).toEqual([
      {
        executionId: "exec-1",
        discardUncaptured: true,
        startedAt: 1_000,
      },
    ]);
  });

  it("drops malformed and expired browser recovery markers", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "workflow-builder:pending-dev-environment-teardowns:v1",
      JSON.stringify([
        { executionId: "exec-1", discardUncaptured: false, startedAt: 1 },
        { executionId: "../unsafe", discardUncaptured: false, startedAt: 100_000_000 },
        { executionId: "exec-2", discardUncaptured: "no", startedAt: 100_000_000 },
      ]),
    );

    expect(
      pendingDevEnvironmentTeardowns({ storage, now: () => 100_000_000 }),
    ).toEqual([]);
    expect(storage.getItem("workflow-builder:pending-dev-environment-teardowns:v1")).toBeNull();
  });
});
