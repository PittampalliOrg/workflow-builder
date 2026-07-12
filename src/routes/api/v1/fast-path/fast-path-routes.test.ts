import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const route = (...parts: string[]) =>
	readFileSync(join(dirname(fileURLToPath(import.meta.url)), ...parts), "utf8");

describe("fast path routes", () => {
	it("keeps service discovery behind workflowData", () => {
		const source = route("services", "+server.ts");
		expect(source).toContain("workflowData.listDevPreviewServices");
		expect(source).not.toContain("$lib/server/db");
	});

	it("keeps preview lifecycle behind application adapters", () => {
		const source = route("executions", "[executionId]", "preview", "+server.ts");
		expect(source).toContain("workflowData.getDevEnvironmentOrPending");
		expect(source).toContain("previewEnvironmentProvisioner.provision");
		expect(source).toContain("previewEnvironmentProvisioner.provisionMany");
		expect(source).toContain("previewEnvironmentProvisioner.teardown");
		expect(source).toContain(
			"status: !result.ok ? 503 : result.complete ? 200 : 202",
		);
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/workflows/dev-preview");
	});

	it("keeps per-service controls behind the dev preview sidecar service", () => {
		const status = route(
			"executions",
			"[executionId]",
			"services",
			"[service]",
			"status",
			"+server.ts",
		);
		const run = route(
			"executions",
			"[executionId]",
			"services",
			"[service]",
			"run",
			"+server.ts",
		);
		const sync = route(
			"executions",
			"[executionId]",
			"services",
			"[service]",
			"sync",
			"+server.ts",
		);
		expect(status).toContain("devPreviewSidecar.status");
		expect(run).toContain("devPreviewSidecar.run");
		expect(sync).toContain("devPreviewSidecar.sync");
		expect(status + run + sync).not.toContain("$lib/server/db");
		expect(status + run + sync).not.toContain("$lib/server/workflows/dev-preview-sidecar");
	});

	it("keeps promotion behind code version application services", () => {
		const source = route("executions", "[executionId]", "promote", "+server.ts");
		expect(source).toContain("workflowCodeVersions.listVersions");
		expect(source).toContain("workflowCodeVersionPromotion.promote");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/workflows/source-bundle");
		expect(source).not.toContain("$lib/server/workflows/helper-pod");
	});
});
