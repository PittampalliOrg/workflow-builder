import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentTargetForSession,
  agentTargetsForSession,
  nodeIdFromChildSessionId,
  sessionRuntimeGenerationAppId,
  sessionRuntimeGenerationInstanceId,
  sessionRequiresRuntimeLinkage,
  sessionHostAppId,
} from "./resolvers";

describe("agentTargetForSession", () => {
  it("carries explicit Sandbox evidence into the lifecycle target", () => {
    expect(
      agentTargetForSession({
        id: "session-1",
        daprInstanceId: "workflow-1",
        runtimeAppId: "agent-session-1",
        runtimeSandboxName: "agent-host-agent-session-1",
      }),
    ).toEqual({
      runtimeAppId: "agent-session-1",
      instanceId: "workflow-1",
      runtimeSandboxName: "agent-host-agent-session-1",
    });
  });

  it("does not infer a per-session target without Sandbox evidence", () => {
    expect(
      agentTargetForSession({
        id: "session-1",
        daprInstanceId: "workflow-1",
        runtimeAppId: null,
        runtimeSandboxName: null,
      }),
    ).toBeNull();
  });

  it("derives the direct Sandbox name when its persistence lags the deterministic app id", () => {
    expect(
      agentTargetForSession({
        id: "session-1",
        daprInstanceId: "workflow-1",
        runtimeAppId: "agent-session-legacy",
        runtimeSandboxName: null,
      }),
    ).toEqual({
      runtimeAppId: "agent-session-legacy",
      instanceId: "workflow-1",
      runtimeSandboxName: "agent-host-agent-session-legacy",
    });
  });

  it("retains the old target and adds the prospective host while leased", () => {
    const startedAt = new Date("2026-07-21T12:00:00Z");
    const prospectiveAppId = sessionRuntimeGenerationAppId(
      "session-1",
      startedAt,
    );
    expect(
      agentTargetsForSession({
        id: "session-1",
        daprInstanceId: "workflow-1",
        runtimeAppId: "agent-runtime-old",
        runtimeSandboxName: "agent-host-old",
        runtimeProvisioningStartedAt: startedAt,
      }),
    ).toEqual([
      {
        runtimeAppId: "agent-runtime-old",
        instanceId: "workflow-1",
        runtimeSandboxName: "agent-host-old",
      },
      {
        runtimeAppId: prospectiveAppId,
        instanceId: sessionRuntimeGenerationInstanceId("session-1", startedAt),
        runtimeSandboxName: `agent-host-${prospectiveAppId}`,
      },
    ]);
  });

  it("deduplicates an already-published prospective target", () => {
    const startedAt = new Date("2026-07-21T12:00:00Z");
    const appId = sessionRuntimeGenerationAppId("session-1", startedAt);
    const instanceId = sessionRuntimeGenerationInstanceId("session-1", startedAt);
    expect(
      agentTargetsForSession({
        id: "session-1",
        daprInstanceId: instanceId,
        runtimeAppId: appId,
        runtimeSandboxName: `agent-host-${appId}`,
        runtimeProvisioningStartedAt: startedAt,
      }),
    ).toHaveLength(1);
  });

	it("uses a staged shared-pool target instead of synthesizing a dedicated host", () => {
		const startedAt = new Date("2026-07-21T12:00:00Z");
		const instanceId = sessionRuntimeGenerationInstanceId(
			"session-1",
			startedAt,
		);
		expect(
			agentTargetsForSession({
				id: "session-1",
				daprInstanceId: null,
				runtimeAppId: null,
				runtimeSandboxName: null,
				runtimeProvisioningStartedAt: startedAt,
				runtimeProvisioningAppId: "agent-runtime-browser-pool",
				runtimeProvisioningInstanceId: instanceId,
				runtimeProvisioningSandboxName: null,
				runtimeProvisioningHostOwned: false,
			}),
		).toEqual([
			{
				runtimeAppId: "agent-runtime-browser-pool",
				instanceId,
				runtimeSandboxName: null,
				ownsRuntimeSandbox: false,
			},
		]);
	});

	it("keeps a staged dedicated target exact", () => {
		const startedAt = new Date("2026-07-21T12:00:00Z");
		expect(
			agentTargetsForSession({
				id: "session-1",
				daprInstanceId: null,
				runtimeAppId: null,
				runtimeProvisioningStartedAt: startedAt,
				runtimeProvisioningAppId: "agent-session-provider-result",
				runtimeProvisioningInstanceId: "session-runtime-provider-result",
				runtimeProvisioningSandboxName:
					"agent-host-agent-session-provider-result",
				runtimeProvisioningHostOwned: true,
			}),
		).toEqual([
			{
				runtimeAppId: "agent-session-provider-result",
				instanceId: "session-runtime-provider-result",
				runtimeSandboxName: "agent-host-agent-session-provider-result",
			},
		]);
	});

  it("isolates successive lease generations for the same session", () => {
    const first = sessionRuntimeGenerationAppId(
      "session-1",
      new Date("2026-07-21T12:00:00.000Z"),
    );
    const replacement = sessionRuntimeGenerationAppId(
      "session-1",
      new Date("2026-07-21T12:00:00.001Z"),
    );

    expect(first).toMatch(/^agent-session-[0-9a-f]{20}$/);
    expect(replacement).toMatch(/^agent-session-[0-9a-f]{20}$/);
    expect(
      sessionRuntimeGenerationAppId(
        "session-1",
        new Date("2026-07-21T12:00:00.000Z"),
      ),
    ).toBe(first);
    expect(replacement).not.toBe(first);
    expect(sessionHostAppId("session-1")).not.toBe(first);
  });

  it("isolates durable instances across lease generations", () => {
    const startedAt = new Date("2026-07-21T12:00:00.000Z");
    const first = sessionRuntimeGenerationInstanceId("session-1", startedAt);
    const replacement = sessionRuntimeGenerationInstanceId(
      "session-1",
      new Date("2026-07-21T12:00:00.001Z"),
    );

    expect(first).toMatch(/^session-runtime-[0-9a-f]{20}$/);
    expect(sessionRuntimeGenerationInstanceId("session-1", startedAt)).toBe(
      first,
    );
    expect(replacement).not.toBe(first);
  });
});

describe("sessionRequiresRuntimeLinkage", () => {
  it("excludes an idle runtime-less script-team lead anchor", () => {
    expect(
      sessionRequiresRuntimeLinkage({
        agentId: "script-team-lead",
        status: "idle",
        daprInstanceId: null,
        runtimeAppId: null,
        runtimeSandboxName: null,
      }),
    ).toBe(false);
  });

  it("keeps ordinary idle sessions and runtime-backed lead rows conservative", () => {
    expect(
      sessionRequiresRuntimeLinkage({
        agentId: "real-agent",
        status: "idle",
        daprInstanceId: null,
        runtimeAppId: null,
        runtimeSandboxName: null,
      }),
    ).toBe(true);
    expect(
      sessionRequiresRuntimeLinkage({
        agentId: "script-team-lead",
        status: "idle",
        daprInstanceId: "lead-runtime",
        runtimeAppId: "agent-session-lead",
        runtimeSandboxName: null,
      }),
    ).toBe(true);
  });
});

describe("nodeIdFromChildSessionId", () => {
	it("keeps lifecycle resolver contracts free of infrastructure imports", () => {
		const source = readFileSync(
			join(process.cwd(), "src/lib/server/lifecycle/resolvers.ts"),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});

	// The per-runtime instance prefixes from services/shared/runtime-registry.json.
	// The wedge gate (resolvers.terminatedChildNodes → shouldForceFinalizeCrossAppWedge)
	// only works if the node id is extracted for EVERY runtime, not just dapr-agent-py.
	const PREFIXES = [
		"durable", // dapr-agent-py (default)
		"durable-claude", // claude-agent-py
		"durable-adk", // adk-agent-py
		"durable-browser-use", // browser-use-agent
		"durable-claude-cli",
		"durable-codex-cli",
		"durable-agy-cli",
		"durable-testing",
	];

	it("extracts the node id for every runtime instance prefix", () => {
		for (const prefix of PREFIXES) {
			const childId = `exec123__${prefix}__build_3b1b_animation__run__0`;
			expect(
				nodeIdFromChildSessionId(childId),
				`prefix ${prefix} should yield the node id`,
			).toBe("build_3b1b_animation");
		}
	});

	it("handles multi-digit run indices and node ids with separators", () => {
    expect(
      nodeIdFromChildSessionId("e__durable-claude__node_a-b__run__12"),
    ).toBe("node_a-b");
    expect(nodeIdFromChildSessionId("e__durable__synthesize__run__0")).toBe(
      "synthesize",
    );
	});

	it("returns null for a non-workflow-driven (direct) session id", () => {
		expect(nodeIdFromChildSessionId("sess_abc123")).toBeNull();
		expect(nodeIdFromChildSessionId("agent-session-deadbeef")).toBeNull();
	});

	it("does not match a bare instanceId without the __run__N suffix", () => {
		expect(nodeIdFromChildSessionId("exec__durable__node")).toBeNull();
	});
});
