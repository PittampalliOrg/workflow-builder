import { describe, expect, it } from "vitest";
import { buildPrSeedCommand, prPreviewRegistryEntries } from "./pr-previews";
import { buildPromotionCommand } from "./workflow-code-version-promotion";
import type { SourceBundlePromotionRunnerInput } from "$lib/server/application/ports";

describe("buildPrSeedCommand", () => {
	const input = {
		prNumber: 42,
		headSha: "deadbeef",
		syncToken: "tok-1",
		targets: [
			{
				service: "workflow-builder",
				repoSubdir: ".",
				syncPaths: ["src"],
				extraSync: [],
				podIp: "10.1.2.3",
				syncPort: 3000,
			},
			{
				service: "workflow-orchestrator",
				repoSubdir: "services/workflow-orchestrator",
				syncPaths: ["app.py", "core"],
				extraSync: [
					{ from: "../shared/workflow-data-contract", to: ".contract-fixtures" },
				],
				podIp: "10.1.2.4",
				syncPort: 8001,
			},
		],
	};

	it("clones the PR head once via pull/<n>/head (fork-safe)", () => {
		const cmd = buildPrSeedCommand(input, "PittampalliOrg/workflow-builder");
		expect(cmd).toContain('git fetch -q --depth 1 origin "pull/42/head"');
		expect(cmd.match(/git fetch/g)).toHaveLength(1);
	});

	it("gzip-tar-POSTs each target's tree to its /__sync with the x-sync-token", () => {
		const cmd = buildPrSeedCommand(input, "PittampalliOrg/workflow-builder");
		expect(cmd).toContain('"http://10.1.2.3:3000/__sync"');
		expect(cmd).toContain('"http://10.1.2.4:8001/__sync"');
		expect(cmd).toContain("x-sync-token: $SYNC_TOKEN");
		expect(cmd).toContain("SYNC_TOKEN='tok-1'");
		expect(cmd).toContain("Content-Type: application/gzip");
		expect(cmd).toContain("tar -czf /tmp/seed-workflow-builder.tgz");
	});

	it("roots each service at its repoSubdir and stages extraSync trees", () => {
		const cmd = buildPrSeedCommand(input, "PittampalliOrg/workflow-builder");
		expect(cmd).toContain('cd "/tmp/pr-src"'); // '.' → repo root
		expect(cmd).toContain('cd "/tmp/pr-src/services/workflow-orchestrator"');
		expect(cmd).toContain("'../shared/workflow-data-contract'");
		expect(cmd).toContain(".contract-fixtures");
	});

	it("emits a per-service result marker for the adapter to parse", () => {
		const cmd = buildPrSeedCommand(input, "PittampalliOrg/workflow-builder");
		expect(cmd).toContain('echo "SEED_workflow_builder=$CODE"');
		expect(cmd).toContain('echo "SEED_workflow_orchestrator=$CODE"');
	});
});

describe("prPreviewRegistryEntries", () => {
	it("exposes the dev-preview registry slice (bff at repo root)", () => {
		const entries = prPreviewRegistryEntries();
		const bff = entries.find((e) => e.service === "workflow-builder");
		expect(bff?.repoSubdir).toBe(".");
		expect(bff?.syncPaths.length).toBeGreaterThan(0);
		const orch = entries.find((e) => e.service === "workflow-orchestrator");
		expect(orch?.repoSubdir).toBe("services/workflow-orchestrator");
	});
});

describe("buildPromotionCommand preview label (D2)", () => {
	const input: SourceBundlePromotionRunnerInput = {
		executionId: "exec-1",
		fileId: "file-1",
		repo: "PittampalliOrg/workflow-builder",
		base: "main",
		mode: "pr",
		title: "Promote test",
		tier: "tar-overlay",
		repoSubdir: ".",
		syncPaths: ["src"],
	};

	it("adds the preview-label curl only when the flag is on", () => {
		const withLabel = buildPromotionCommand(input, "tok", "http://bff/bundle", {
			addPreviewLabel: true,
		});
		expect(withLabel).toContain('/issues/$NUM/labels');
		expect(withLabel).toContain('{"labels":["preview"]}');
		expect(withLabel).toContain("PREVIEW_LABEL_HTTP=");

		const withoutLabel = buildPromotionCommand(input, "tok", "http://bff/bundle");
		expect(withoutLabel).not.toContain("/labels");
		expect(withoutLabel).not.toContain("PREVIEW_LABEL_HTTP");
	});

	it("keeps the PR-create call untouched", () => {
		const cmd = buildPromotionCommand(input, "tok", "http://bff/bundle", {
			addPreviewLabel: true,
		});
		expect(cmd).toContain("https://api.github.com/repos/$REPO/pulls");
		expect(cmd).toContain('echo "PR_URL=$URL"');
	});
});
