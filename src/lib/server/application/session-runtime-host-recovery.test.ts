import { describe, expect, it, vi } from "vitest";
import {
  ApplicationSessionRuntimeHostRecoveryService,
  ensurePublishedSessionRuntimeHost,
} from "./session-runtime-host-recovery";

const SESSION_ID = "session-1";
const APP_ID = "agent-session-generation-1";
const SANDBOX_NAME = `agent-host-${APP_ID}`;
const STARTED_AT = new Date("2026-07-21T21:00:00.001Z");
const LAUNCH_SPEC = {
  version: 1,
  request: { sessionId: SESSION_ID, agentAppId: APP_ID },
  secretEnvKeys: ["KIMI_API_KEY"],
};

function deps(options?: {
  activations?: Array<"active" | "absent">;
  completion?:
    | "completed"
    | "already_completed"
    | "stopped"
    | "superseded"
    | "conflict";
  inspect?: boolean;
  begin?: boolean;
}) {
  const activations = [...(options?.activations ?? ["active"])];
  return {
    repository: {
      inspectSessionRuntimeHostRecovery: vi.fn(async () =>
        options?.inspect === false
          ? null
          : {
              runtimeAppId: APP_ID,
              runtimeSandboxName: SANDBOX_NAME,
              launchSpec: LAUNCH_SPEC,
              recoveryStartedAt: null as Date | null,
            },
      ),
      beginSessionRuntimeHostRecovery: vi.fn(async () =>
        options?.begin === false
          ? null
          : {
              startedAt: STARTED_AT,
              runtimeAppId: APP_ID,
              runtimeSandboxName: SANDBOX_NAME,
              launchSpec: LAUNCH_SPEC,
            },
      ),
      completeSessionRuntimeHostRecovery: vi.fn(
        async () => options?.completion ?? "completed",
      ),
    },
    provider: {
      activate: vi.fn(async () => activations.shift() ?? "active"),
      recreate: vi.fn(async () => undefined),
    },
    cleanup: {
      cleanup: vi.fn(async () => true),
    },
  };
}

const input = {
  sessionId: SESSION_ID,
  runtimeAppId: APP_ID,
  runtimeSandboxName: SANDBOX_NAME,
  sessionSecretEnv: { KIMI_API_KEY: "test-only" },
  traceContext: {
    traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    tracestate: null,
    baggage: "workflow.id=workflow-1",
  },
};

describe("published session runtime host recovery", () => {
  it("leaves an existing exact generation active without allocating a lease", async () => {
    const ports = deps();

    await expect(
      new ApplicationSessionRuntimeHostRecoveryService(ports).ensurePublished(
        input,
      ),
    ).resolves.toEqual({ recovered: false });

    expect(
      ports.repository.beginSessionRuntimeHostRecovery,
    ).not.toHaveBeenCalled();
    expect(ports.provider.recreate).not.toHaveBeenCalled();
  });

  it("cleans up when stop wins completion of an already-active recovery retry", async () => {
    const ports = deps({ completion: "stopped" });
    vi.mocked(
      ports.repository.inspectSessionRuntimeHostRecovery,
    ).mockResolvedValueOnce({
      runtimeAppId: APP_ID,
      runtimeSandboxName: SANDBOX_NAME,
      launchSpec: LAUNCH_SPEC,
      recoveryStartedAt: STARTED_AT,
    });

    await expect(
      ensurePublishedSessionRuntimeHost(ports, input),
    ).rejects.toMatchObject({ code: "runtime_stopping" });

    expect(
      ports.repository.beginSessionRuntimeHostRecovery,
    ).not.toHaveBeenCalled();
    expect(ports.provider.recreate).not.toHaveBeenCalled();
    expect(ports.cleanup.cleanup).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      runtimeSandboxName: SANDBOX_NAME,
      leaseStartedAt: STARTED_AT,
    });
  });

  it("recreates and activates the same published generation after provider absence", async () => {
    const ports = deps({ activations: ["absent", "active"] });

    await expect(
      ensurePublishedSessionRuntimeHost(ports, input),
    ).resolves.toEqual({
      recovered: true,
    });

    expect(ports.provider.recreate).toHaveBeenCalledWith({
      runtimeAppId: APP_ID,
      runtimeSandboxName: SANDBOX_NAME,
      launchSpec: LAUNCH_SPEC,
      sessionSecretEnv: { KIMI_API_KEY: "test-only" },
      traceContext: input.traceContext,
    });
    expect(
      ports.repository.completeSessionRuntimeHostRecovery,
    ).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      expectedRuntimeAppId: APP_ID,
      expectedStartedAt: STARTED_AT,
    });
    expect(ports.provider.activate).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(ports.provider.activate).mock.invocationCallOrder[1],
    ).toBeLessThan(
      vi.mocked(ports.repository.completeSessionRuntimeHostRecovery).mock
        .invocationCallOrder[0],
    );
  });

  it("retries and completes the exact lease after recreated-host activation fails", async () => {
    const ports = deps();
    vi.mocked(ports.repository.inspectSessionRuntimeHostRecovery)
      .mockResolvedValueOnce({
        runtimeAppId: APP_ID,
        runtimeSandboxName: SANDBOX_NAME,
        launchSpec: LAUNCH_SPEC,
        recoveryStartedAt: null,
      })
      .mockResolvedValueOnce({
        runtimeAppId: APP_ID,
        runtimeSandboxName: SANDBOX_NAME,
        launchSpec: LAUNCH_SPEC,
        recoveryStartedAt: STARTED_AT,
      });
    vi.mocked(ports.provider.activate)
      .mockResolvedValueOnce("absent")
      .mockRejectedValueOnce(new Error("activation endpoint unavailable"))
      .mockResolvedValueOnce("active");

    await expect(
      ensurePublishedSessionRuntimeHost(ports, input),
    ).rejects.toThrow("activation endpoint unavailable");

    expect(ports.provider.recreate).toHaveBeenCalledTimes(1);
    expect(
      ports.repository.completeSessionRuntimeHostRecovery,
    ).not.toHaveBeenCalled();
    expect(ports.cleanup.cleanup).not.toHaveBeenCalled();

    await expect(
      ensurePublishedSessionRuntimeHost(ports, input),
    ).resolves.toEqual({ recovered: false });

    expect(ports.provider.recreate).toHaveBeenCalledTimes(1);
    expect(
      ports.repository.beginSessionRuntimeHostRecovery,
    ).toHaveBeenCalledTimes(1);
    expect(
      ports.repository.completeSessionRuntimeHostRecovery,
    ).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      expectedRuntimeAppId: APP_ID,
      expectedStartedAt: STARTED_AT,
    });
    expect(ports.cleanup.cleanup).not.toHaveBeenCalled();
  });

  it("retains the exact recovery lease when the recreated host is still absent", async () => {
    const ports = deps({ activations: ["absent", "absent"] });

    await expect(
      ensurePublishedSessionRuntimeHost(ports, input),
    ).rejects.toMatchObject({ code: "runtime_recovery_unavailable" });

    expect(ports.provider.recreate).toHaveBeenCalledTimes(1);
    expect(
      ports.repository.completeSessionRuntimeHostRecovery,
    ).not.toHaveBeenCalled();
    expect(ports.cleanup.cleanup).not.toHaveBeenCalled();
  });

  it("cleans up the activated provisional host when stop wins completion", async () => {
    const ports = deps({
      activations: ["absent", "active"],
      completion: "stopped",
    });

    await expect(
      ensurePublishedSessionRuntimeHost(ports, input),
    ).rejects.toMatchObject({
      code: "runtime_stopping",
    });

    expect(ports.provider.recreate).toHaveBeenCalledTimes(1);
    expect(ports.provider.activate).toHaveBeenCalledTimes(2);
    expect(ports.cleanup.cleanup).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      runtimeSandboxName: SANDBOX_NAME,
      leaseStartedAt: STARTED_AT,
    });
  });

  it("requests cleanup when supersession wins after provisional activation", async () => {
    const ports = deps({
      activations: ["absent", "active"],
      completion: "superseded",
    });

    await expect(
      ensurePublishedSessionRuntimeHost(ports, input),
    ).rejects.toMatchObject({ code: "runtime_superseded" });

    expect(ports.cleanup.cleanup).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      runtimeSandboxName: SANDBOX_NAME,
      leaseStartedAt: STARTED_AT,
    });
  });

  it("adopts a concurrent exact-generation recovery without deleting its host", async () => {
    const ports = deps({
      activations: ["absent", "active"],
      completion: "already_completed",
    });

    await expect(
      ensurePublishedSessionRuntimeHost(ports, input),
    ).resolves.toEqual({
      recovered: true,
    });

    expect(ports.cleanup.cleanup).not.toHaveBeenCalled();
    expect(ports.provider.activate).toHaveBeenCalledTimes(2);
  });

  it("does not call the provider when persisted lifecycle authority is gone", async () => {
    const ports = deps({ inspect: false });

    await expect(
      ensurePublishedSessionRuntimeHost(ports, input),
    ).rejects.toMatchObject({
      code: "runtime_recovery_unavailable",
    });

    expect(ports.provider.activate).not.toHaveBeenCalled();
    expect(ports.provider.recreate).not.toHaveBeenCalled();
  });
});
