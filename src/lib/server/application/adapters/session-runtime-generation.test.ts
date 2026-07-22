import { describe, expect, it } from "vitest";
import type { StaleSessionRuntimeProvisioningTarget } from "$lib/server/application/ports";
import { createSessionRuntimeProvisioningReplacement } from "./session-runtime-generation";

const STARTED_AT = new Date("2026-07-21T20:00:00.000Z");

function target(
  overrides: Partial<StaleSessionRuntimeProvisioningTarget> = {},
): StaleSessionRuntimeProvisioningTarget {
  const runtimeAppId = overrides.runtimeAppId ?? "agent-session-current";
  return {
    sessionId: "session-1",
    startedAt: new Date("2026-07-21T18:00:00.000Z"),
    runtimeAppId,
    durableInstanceId: "session-runtime-current",
    runtimeSandboxName: null,
    runtimeHostOwned: false,
    runtimeHostLaunchSpec: null,
    publishedGeneration: false,
    ...overrides,
  };
}

describe("session runtime generation adapter", () => {
  it("keeps a shared host while deriving a fresh durable generation", () => {
    const current = target({ runtimeAppId: "agent-runtime-shared" });
    const replacement = createSessionRuntimeProvisioningReplacement({
      current,
      startedAt: STARTED_AT,
    });

    expect(replacement).toMatchObject({
      runtimeAppId: "agent-runtime-shared",
      runtimeSandboxName: null,
      runtimeHostOwned: false,
      runtimeHostLaunchSpec: null,
    });
    expect(replacement.durableInstanceId).not.toBe(current.durableInstanceId);
  });

  it("rotates an owned app, Sandbox, and opaque launch recipe deterministically", () => {
    const current = target({
      runtimeHostOwned: true,
      runtimeSandboxName: "agent-host-agent-session-current",
      runtimeHostLaunchSpec: {
        version: 1,
        request: {
          sessionId: "session-1",
          agentAppId: "agent-session-current",
          instanceId: "workflow-1",
          priorityClass: "interactive",
        },
        secretEnvKeys: ["KIMI_API_KEY"],
      },
    });
    const input = { current, startedAt: STARTED_AT };
    const originalLaunchSpec = structuredClone(current.runtimeHostLaunchSpec);

    const first = createSessionRuntimeProvisioningReplacement(input);
    const replay = createSessionRuntimeProvisioningReplacement(input);

    expect(replay).toEqual(first);
    expect(current.runtimeHostLaunchSpec).toEqual(originalLaunchSpec);
    expect(first.runtimeAppId).not.toBe(current.runtimeAppId);
    expect(first.durableInstanceId).not.toBe(current.durableInstanceId);
    expect(first.runtimeSandboxName).toBe(`agent-host-${first.runtimeAppId}`);
    expect(first.runtimeHostLaunchSpec).toEqual({
      version: 1,
      request: {
        sessionId: "session-1",
        agentAppId: first.runtimeAppId,
        instanceId: "workflow-1",
        priorityClass: "interactive",
      },
      secretEnvKeys: ["KIMI_API_KEY"],
    });
  });

  it("rejects malformed or mismatched owned launch metadata", () => {
    const malformed = target({
      runtimeHostOwned: true,
      runtimeSandboxName: "agent-host-agent-session-current",
      runtimeHostLaunchSpec: { version: 1 },
    });
    expect(() =>
      createSessionRuntimeProvisioningReplacement({
        current: malformed,
        startedAt: STARTED_AT,
      }),
    ).toThrow("invalid persisted agent workflow host launch specification");

    const mismatched = target({
      runtimeHostOwned: true,
      runtimeSandboxName: "agent-host-agent-session-current",
      runtimeHostLaunchSpec: {
        version: 1,
        request: {
          sessionId: "another-session",
          agentAppId: "agent-session-current",
        },
        secretEnvKeys: [],
      },
    });
    expect(() =>
      createSessionRuntimeProvisioningReplacement({
        current: mismatched,
        startedAt: STARTED_AT,
      }),
    ).toThrow("persisted agent workflow host generation does not match");
  });
});
