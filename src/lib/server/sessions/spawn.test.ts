import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("session spawn wiring", () => {
	it("keeps session row lookup and runtime attachment behind workflow-data", () => {
		const source = readFileSync(new URL("./spawn.ts", import.meta.url), "utf8");
    const recoverySource = readFileSync(
      new URL("./runtime-host-recovery.ts", import.meta.url),
      "utf8",
    );

		expect(source).toContain("workflowData.getSessionDetail");
		expect(source).toContain("workflowData.resolveSessionAgent");
		expect(source).toContain("workflowData.resolvePeerAgentDispatchContext");
    expect(source).toContain("workflowData.reserveSessionRuntimeProvisioning");
    expect(source).toContain("workflowData.releaseSessionRuntimeProvisioning");
    expect(source).toContain(
      "workflowData.attachStagedSessionRuntimeProvisioning",
    );
    expect(source).toContain("workflowData.completeSessionRuntimeHostRecovery");
    expect(source).toContain("workflowData.stageSessionRuntimeProvisioning");
    expect(source).toContain(
      "sessionCommands.cleanupUnpublishedRuntimeProvisioning",
    );
    expect(source).toContain("requiresStartAuthority: true");
    expect(source).toContain(
      "provisioningStartedAt: provisioningLease.startedAt",
    );
    expect(source).toContain("sessionRuntimeGenerationInstanceId(");
    expect(source).toContain("ensurePublishedAgentWorkflowHostGeneration");
    expect(source).toContain(
      "const runtimeHostLaunchSpec = stagedRuntimeTarget",
    );
    expect(source).toContain(": (sessionHost?.launchSpec ?? null)");
    expect(source).toContain("runtimeHostLaunchSpec,");
    expect(source).toContain('session.status !== "terminated"');
    expect(source).toContain("!session.completedAt");
    expect(source).toContain("durableInstance: {");
    expect(source).not.toContain("purgeUnpublishedRuntimeInstance");
    expect(source).toContain('durableStartState = "ambiguous"');
    expect(source).toContain('durableStartState === "accepted"');
		expect(source).toContain("workflowData.listSessionEvents");
    expect(source).toContain("teamMailboxDelivery.initialUserEvents(");
    expect(source).toContain("requestDeliveryAfterRuntimePublished(");
		expect(source).toContain("workflowData.appendSessionEvent");
		expect(source).toContain("workflowData.getWorkflowExecutionWorkspaceKey");
		expect(source).toContain("runtimeUsesSharedWorkspace");
    expect(source).toContain(
      "if (stagedRuntimeTarget || options.requireWorkflowHost) throw err",
    );
		expect(source).toContain("options.requireWorkflowHost && !sessionHost");
		expect(source).toContain("environments.resolveRuntimeByRef");
    expect(source).toContain(
      "sessionCommands.materializeSessionRepositoriesViaHost",
    );
    const leaseIndex = source.indexOf("const provisioningLease =");
    const hostIndex = source.indexOf("maybeProvisionAgentWorkflowHost({");
    const startIndex = source.indexOf("const res = await");
    const stageIndex = source.indexOf(
      "const staged = await workflowData.stageSessionRuntimeProvisioning",
    );
    const attachIndex = source.indexOf(
      "const attached = await workflowData.attachStagedSessionRuntimeProvisioning",
    );
    const cleanupIndex = source.lastIndexOf(
      "sessionCommands.cleanupUnpublishedRuntimeProvisioning",
    );
    const activationIndex = source.lastIndexOf(
      "await ensurePublishedAgentWorkflowHostGeneration",
    );
    const completionIndex = source.lastIndexOf(
      "await workflowData.completeSessionRuntimeHostRecovery",
    );
    const mailboxDeliveryIndex = source.lastIndexOf(
      "await requestPendingTeamMailboxDelivery(sessionId)",
    );
    expect(leaseIndex).toBeGreaterThanOrEqual(0);
    expect(hostIndex).toBeGreaterThan(leaseIndex);
    expect(stageIndex).toBeGreaterThan(hostIndex);
    expect(startIndex).toBeGreaterThan(stageIndex);
    expect(attachIndex).toBeGreaterThan(startIndex);
    expect(cleanupIndex).toBeGreaterThan(attachIndex);
    expect(activationIndex).toBeGreaterThan(attachIndex);
    expect(completionIndex).toBeGreaterThan(activationIndex);
    expect(mailboxDeliveryIndex).toBeGreaterThan(completionIndex);
		expect(source).not.toContain("$lib/server/agents/registry");
		expect(source).not.toContain("$lib/server/agents/registry-sync");
		expect(source).not.toContain("$lib/server/environments/registry");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("$lib/server/sessions/events");
		expect(source).not.toContain("$lib/server/sessions/repositories");
		expect(source).not.toContain("resolveEnvironmentRef");
		expect(source).not.toContain("attachRuntime");
		expect(source).not.toContain("getSession(");
		expect(source).not.toContain("appendEvent(");
		expect(source).not.toContain("listEvents(");
    expect(recoverySource).not.toContain('from "$lib/server/application"');
	});
});
