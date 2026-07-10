import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceRuntimeUrl } from "$lib/server/dapr-client";
import {
	getOpenShellRuntimeUrl,
	getOpenShellRuntimeWsUrl,
} from "$lib/server/openshell-runtime";

afterEach(() => vi.unstubAllEnvs());

describe("PreviewEnvironment host runtime isolation", () => {
	it("marks host workspace and OpenShell runtimes unavailable", () => {
		vi.stubEnv("PREVIEW_HOST_RUNTIMES_DISABLED", "true");
		vi.stubEnv("WORKSPACE_RUNTIME_URL", "");

		expect(() => getWorkspaceRuntimeUrl()).toThrow(
			"workspace-runtime is unavailable",
		);
		expect(() => getOpenShellRuntimeUrl()).toThrow(
			"OpenShell is unavailable",
		);
		expect(() => getOpenShellRuntimeWsUrl()).toThrow(
			"OpenShell is unavailable",
		);
	});

	it("keeps the persistent environment defaults unchanged", () => {
		expect(getWorkspaceRuntimeUrl()).toBe(
			"http://workspace-runtime.workflow-builder.svc.cluster.local:8001",
		);
		expect(getOpenShellRuntimeUrl()).toContain("openshell-agent-runtime");
	});
});
