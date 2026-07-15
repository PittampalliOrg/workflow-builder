import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "+page.svelte"),
	"utf8",
);

describe("workspace dev detail polling", () => {
	it("keeps one remote query handle whose refreshed values drive services and lifecycle", () => {
		expect(pageSource).toContain(
			"const initialExecutionId = untrack(() => data.environment.executionId);",
		);
		expect(pageSource).toContain(
			"const envQuery = getDevEnvironment(initialExecutionId);",
		);
		expect(pageSource).not.toContain(
			"$derived(getDevEnvironment(data.environment.executionId))",
		);
		expect(pageSource).toContain(
			"envQuery.current?.environment ?? data.environment",
		);
		expect(pageSource).toContain(
			"envQuery.current?.services ?? data.services ?? [data.environment]",
		);
		expect(pageSource).toContain(
			"setInterval(() => void envQuery.refresh(), 5000)",
		);
		expect(pageSource).toContain("runStatus: environment.runStatus");
		expect(pageSource).toContain("<StatusPill status={lifecycle.effectiveStatus}");
		expect(pageSource).toContain("{services.length} service");
		expect(pageSource).toContain("{#each services as svc (svc.service)}");
	});

	it("awaits each sidecar query resource after refresh before deriving checkpoint state", () => {
		expect(pageSource).toContain("await query.refresh()");
		expect(pageSource).toContain("const view = await query");
		expect(pageSource).not.toContain("const view = query.current");
	});

	it("uses a stable idempotent service checkpoint callback", () => {
		expect(pageSource).toContain(
			"const current = untrack(() => serviceCheckpointStates);",
		);
		expect(pageSource).toContain("if (current[service] === state) return;");
		expect(pageSource).toContain(
			"oncheckpointstate={updateServiceCheckpointState}",
		);
		expect(pageSource).not.toContain(
			"oncheckpointstate={(service, state) =>",
		);
	});

	it("shows durable teardown reconciliation instead of a raw transport failure", () => {
		expect(pageSource).toContain("type DevEnvironmentTeardownProgress");
		expect(pageSource).toContain("pendingDevEnvironmentTeardowns()");
		expect(pageSource).toContain("onProgress: (progress) => {");
		expect(pageSource).toContain("armTeardownReloadFallback()");
		expect(pageSource).toContain(
			"Connection changed. Verifying the durable teardown receipt",
		);
		expect(pageSource).toContain('role="status" aria-live="polite"');
		expect(pageSource).toContain("Discarding uncaptured changes and starting cleanup");
	});
});
