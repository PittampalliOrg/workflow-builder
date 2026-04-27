import { describe, expect, it } from "vitest";
import type { EnvironmentConfig } from "$lib/types/environments";
import {
	inferWorkflowBuilderEnvironmentName,
	resolveSandboxImage,
} from "./image-resolution";

function envConfig(overrides: Partial<EnvironmentConfig> = {}): EnvironmentConfig {
	return {
		sandboxMode: "per-run",
		keepAfterRun: false,
		ttlSeconds: 7200,
		networking: { type: "unrestricted" },
		...overrides,
	};
}

const SPOKE_IMAGE_MAP = {
	"dapr-agent":
		"ghcr.io/pittampalliorg/openshell-sandbox:git-16a428b0acf22d940f3154e0dbe08b90217721da",
	"default-sandbox":
		"ghcr.io/pittampalliorg/openshell-sandbox:git-16a428b0acf22d940f3154e0dbe08b90217721da",
	"dapr-agent-xlsx":
		"ghcr.io/pittampalliorg/openshell-sandbox-xlsx:git-16a428b0acf22d940f3154e0dbe08b90217721da",
	xlsx:
		"ghcr.io/pittampalliorg/openshell-sandbox-xlsx:git-16a428b0acf22d940f3154e0dbe08b90217721da",
};

describe("resolveSandboxImage", () => {
	it("returns stored ryzen-local image refs unchanged on ryzen", () => {
		const result = resolveSandboxImage({
			environmentName: "ryzen",
			envSlug: "dapr-agent",
			config: envConfig(),
			storedImageTag:
				"gitea-ryzen.tail286401.ts.net/giteaadmin/openshell-sandbox:latest",
			translatedImageMap: SPOKE_IMAGE_MAP,
		});

		expect(result).toEqual({
			imageTag:
				"gitea-ryzen.tail286401.ts.net/giteaadmin/openshell-sandbox:latest",
			imageSource: "stored",
		});
	});

	it("translates dapr-agent to GHCR on dev/staging", () => {
		const result = resolveSandboxImage({
			environmentName: "dev",
			envSlug: "dapr-agent",
			config: envConfig(),
			storedImageTag:
				"gitea-ryzen.tail286401.ts.net/giteaadmin/openshell-sandbox:latest",
			translatedImageMap: SPOKE_IMAGE_MAP,
		});

		expect(result).toEqual({
			imageTag:
				"ghcr.io/pittampalliorg/openshell-sandbox:git-16a428b0acf22d940f3154e0dbe08b90217721da",
			imageSource: "translated",
		});
	});

	it("prefers direct spoke pins over stale stored builtin images", () => {
		const result = resolveSandboxImage({
			environmentName: "dev",
			envSlug: "dapr-agent",
			config: envConfig(),
			storedImageTag:
				"ghcr.io/pittampalliorg/openshell-sandbox:git-58783236bd0b04c57f7a320b5eaa5cebbfd974b2",
			translatedImageMap: SPOKE_IMAGE_MAP,
		});

		expect(result).toEqual({
			imageTag:
				"ghcr.io/pittampalliorg/openshell-sandbox:git-16a428b0acf22d940f3154e0dbe08b90217721da",
			imageSource: "translated",
		});
	});

	it("translates dapr-agent-xlsx to GHCR on dev/staging", () => {
		const result = resolveSandboxImage({
			environmentName: "staging",
			envSlug: "dapr-agent-xlsx",
			config: envConfig(),
			storedImageTag:
				"gitea-ryzen.tail286401.ts.net/giteaadmin/openshell-sandbox-xlsx:latest",
			translatedImageMap: SPOKE_IMAGE_MAP,
		});

		expect(result).toEqual({
			imageTag:
				"ghcr.io/pittampalliorg/openshell-sandbox-xlsx:git-16a428b0acf22d940f3154e0dbe08b90217721da",
			imageSource: "translated",
		});
	});

	it("resolves default-sandbox through dapr-agent when the concrete image is delegated", () => {
		const result = resolveSandboxImage({
			environmentName: "dev",
			envSlug: "default-sandbox",
			config: envConfig({ sandboxTemplate: "dapr-agent" }),
			storedImageTag: null,
			templateResolution: {
				imageTag:
					"ghcr.io/pittampalliorg/openshell-sandbox:git-16a428b0acf22d940f3154e0dbe08b90217721da",
				imageSource: "translated",
			},
			translatedImageMap: SPOKE_IMAGE_MAP,
		});

		expect(result).toEqual({
			imageTag:
				"ghcr.io/pittampalliorg/openshell-sandbox:git-16a428b0acf22d940f3154e0dbe08b90217721da",
			imageSource: "translated",
		});
	});

	it("does not leak unknown ryzen-local sandbox images into dev/staging", () => {
		const result = resolveSandboxImage({
			environmentName: "dev",
			envSlug: "dapr-agent-animation",
			config: envConfig(),
			storedImageTag:
				"gitea-ryzen.tail286401.ts.net/giteaadmin/openshell-sandbox-dapr-agent-animation:latest",
			translatedImageMap: SPOKE_IMAGE_MAP,
		});

		expect(result.imageTag).toBeNull();
		expect(result.imageSource).toBe("unconfigured");
		expect(result.imageResolutionWarning).toContain("dapr-agent-animation");
		expect(result.imageResolutionWarning).toContain("ryzen-local");
	});
});

describe("inferWorkflowBuilderEnvironmentName", () => {
	it("prefers explicit environment variables", () => {
		expect(
			inferWorkflowBuilderEnvironmentName({ WORKFLOW_BUILDER_ENV: "staging" }),
		).toBe("staging");
	});

	it("falls back to the public URL", () => {
		expect(
			inferWorkflowBuilderEnvironmentName({
				APP_PUBLIC_URL: "https://workflow-builder-dev.tail286401.ts.net",
			}),
		).toBe("dev");
	});
});
