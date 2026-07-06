import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_SYNC_PATHS,
	DEV_PREVIEW_SERVICES,
	devPreviewCommands,
	devPreviewSyncPaths,
	resolveDevPreviewDescriptor,
	resolveDevPreviewImage,
} from "./dev-preview-registry";

describe("dev-preview registry", () => {
	it("resolves explicit syncPaths, else the language-family default", () => {
		// Explicit list wins.
		expect(devPreviewSyncPaths(DEV_PREVIEW_SERVICES["workflow-orchestrator"])).toEqual([
			"app.py",
			"core",
			"activities",
			"workflows",
			"tests",
			"subscriptions",
		]);
		// mcp-gateway omits syncPaths → node default.
		expect(devPreviewSyncPaths(DEV_PREVIEW_SERVICES["mcp-gateway"])).toEqual(
			DEFAULT_SYNC_PATHS.node,
		);
		expect(devPreviewSyncPaths(DEV_PREVIEW_SERVICES["workflow-mcp-server"])).toEqual([
			"src",
			"config",
		]);
	});

	it("builds the /__run allowlist from depsCommand + testCommands", () => {
		// BFF: deps + a contract lane + the CI gate lanes (check/test-unit/boundaries).
		expect(devPreviewCommands(DEV_PREVIEW_SERVICES["workflow-builder"])).toEqual({
			deps: "pnpm install --no-frozen-lockfile",
			contract:
				"node_modules/.bin/vitest run src/routes/api/internal/workflow-data/workflow-data-contract.test.ts",
			check: "pnpm check",
			"test-unit": "pnpm test:unit",
			boundaries: "pnpm check:boundaries",
		});
		// Orchestrator: python deps + a pytest contract lane.
		expect(devPreviewCommands(DEV_PREVIEW_SERVICES["workflow-orchestrator"])).toEqual({
			deps: "pip install -r requirements.txt && touch /app/app.py",
			contract: "python -m pytest tests/test_workflow_data_activity_migration.py -q",
		});
		// swebench-coordinator declares neither → empty (POST /__run then 404s).
		expect(devPreviewCommands(DEV_PREVIEW_SERVICES["swebench-coordinator"])).toEqual({});
	});

	it("flips a plugin service to sidecar transport only when WFB_DEV_SYNC_MODE=sidecar", () => {
		const plugin = resolveDevPreviewDescriptor("workflow-builder", {});
		expect(plugin.syncMode).toBe("plugin");
		expect(plugin.syncPort).toBe(3000);

		const flipped = resolveDevPreviewDescriptor("workflow-builder", {
			WFB_DEV_SYNC_MODE: "sidecar",
		});
		expect(flipped.syncMode).toBe("sidecar");
		expect(flipped.syncPort).toBe(8001);
		// Everything else is preserved (adopt + functional stay intact).
		expect(flipped.adoptTlsTerminator).toBe(true);
		expect(flipped.functional).toBe(true);

		// A service already in sidecar mode is untouched by the flag.
		const orch = resolveDevPreviewDescriptor("workflow-orchestrator", {
			WFB_DEV_SYNC_MODE: "sidecar",
		});
		expect(orch.syncMode).toBe("sidecar");
		expect(orch.syncPort).toBe(8001);
	});

	it("registers mcp-gateway + workflow-mcp-server as sidecar services with no stacks pin", () => {
		const gw = DEV_PREVIEW_SERVICES["mcp-gateway"];
		expect(gw.syncMode).toBe("sidecar");
		expect(gw.port).toBe(8080);
		expect(gw.healthPath).toBe("/health");
		expect(gw.repoSubdir).toBe("services/mcp-gateway");
		expect(gw.imageFallback).toContain(":latest");

		const wf = DEV_PREVIEW_SERVICES["workflow-mcp-server"];
		expect(wf.syncMode).toBe("sidecar");
		expect(wf.port).toBe(3200);
		expect(wf.healthPath).toBe("/health");
		expect(wf.imageFallback).toContain(":latest");
	});

	it("wires the B4 contract paths on both sides of the boundary", () => {
		// BFF syncs the shared contract into its cwd so the contract vitest sees it.
		expect(DEV_PREVIEW_SERVICES["workflow-builder"].syncPaths).toContain(
			"services/shared/workflow-data-contract",
		);
		// Orchestrator stages the same contract into its baked fixture dir via extraSync.
		expect(DEV_PREVIEW_SERVICES["workflow-orchestrator"].extraSync).toEqual([
			{ from: "../shared/workflow-data-contract", to: ".contract-fixtures" },
		]);
	});

	it("throws on an unknown service", () => {
		expect(() => resolveDevPreviewDescriptor("nope", {})).toThrow(/Unknown dev-preview service/);
	});

	it("resolves the dev image file-first, then env, then the descriptor fallback", () => {
		const d = DEV_PREVIEW_SERVICES["workflow-builder"];
		const dir = mkdtempSync(join(tmpdir(), "dpr-"));
		const pinFile = join(dir, "runtime-images.json");
		writeFileSync(pinFile, JSON.stringify({ [d.imageEnvKey]: "img:file" }));
		// file wins over the env pin
		expect(
			resolveDevPreviewImage(d, {
				WORKFLOW_BUILDER_IMAGE_PINS_FILE: pinFile,
				[d.imageEnvKey]: "img:env",
			}),
		).toBe("img:file");
		// no file → env pin
		expect(resolveDevPreviewImage(d, { [d.imageEnvKey]: "img:env" })).toBe("img:env");
		// neither → descriptor fallback
		expect(resolveDevPreviewImage(d, {})).toBe(d.imageFallback);
	});
});
