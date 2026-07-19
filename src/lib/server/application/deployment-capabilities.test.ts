import { describe, expect, it } from "vitest";
import { EnvironmentDeploymentCapabilityPolicyAdapter } from "$lib/server/application/adapters/deployment-capabilities";
import { ApplicationDeploymentCapabilitiesService } from "$lib/server/application/deployment-capabilities";

const previewDeployment = {
	name: "feature-one",
	profile: "app-live",
	platformRevision: null,
	sourceRevision: null,
	origin: null,
};

const PREVIEW_FUNCTION_REGISTRY = JSON.stringify({
	"system/*": { appId: "fn-system", type: "knative" },
	"workflow-orchestrator/*": {
		appId: "workflow-orchestrator",
		type: "knative",
	},
	code: { appId: "code-runtime", type: "knative" },
	"code/*": { appId: "code-runtime", type: "knative" },
	"web/*": { appId: "crawl4ai-adapter", type: "knative" },
});
const PREVIEW_NATIVE_ACTION_SLUGS = JSON.stringify([
	"durable/run",
	"goal/plan",
]);

function service(input: {
	preview?: boolean;
	previewFunctionRegistryJson?: string | null;
	previewNativeActionSlugsJson?: string | null;
	github?: { clientId: string | null; clientSecret: string | null };
	google?: { clientId: string | null; clientSecret: string | null };
} = {}) {
	return new ApplicationDeploymentCapabilitiesService(
		new EnvironmentDeploymentCapabilityPolicyAdapter({
			previewDeployment: input.preview ? previewDeployment : null,
			previewFunctionRegistryJson:
				input.previewFunctionRegistryJson === undefined
					? PREVIEW_FUNCTION_REGISTRY
					: input.previewFunctionRegistryJson,
			previewNativeActionSlugsJson:
				input.previewNativeActionSlugsJson === undefined
					? PREVIEW_NATIVE_ACTION_SLUGS
					: input.previewNativeActionSlugsJson,
			socialAuth: {
				github: input.github ?? { clientId: "github-id", clientSecret: "github-secret" },
				google: input.google ?? { clientId: "google-id", clientSecret: "google-secret" },
			},
		}),
	);
}

describe("deployment capability policy", () => {
	it("mirrors the strict preview function registry and excludes coordinator work", () => {
		const capabilities = service({ preview: true });

		for (const slug of [
			"durable/run",
			"goal/plan",
			"system/dapr-converse",
			"code/run",
			"web/fetch",
		]) {
			expect(capabilities.actionAvailability(slug)).toEqual({
				available: true,
				code: "available",
				message: null,
			});
		}
		for (const slug of [
			"browser/start-preview",
			"browser/validate",
			"openshell/exec",
			"workspace/profile",
			"github/create_issue",
		]) {
			expect(capabilities.actionAvailability(slug)).toMatchObject({
				available: false,
				code: "unsupported_in_preview",
			});
		}
		expect(
			capabilities.coordinatedWorkloadAvailability("benchmark"),
		).toMatchObject({ available: false, code: "unsupported_in_preview" });
	});

	it("fails closed for malformed or undeclared preview-native actions", () => {
		for (const previewNativeActionSlugsJson of [
			null,
			"{bad json",
			JSON.stringify([" durable/run "]),
		] as const) {
			const capabilities = service({ preview: true, previewNativeActionSlugsJson });
			expect(capabilities.actionAvailability("durable/run")).toMatchObject({
				available: false,
				code: "unsupported_in_preview",
			});
			expect(capabilities.actionAvailability("system/dapr-converse")).toEqual({
				available: true,
				code: "available",
				message: null,
			});
		}
	});

	it("fails closed when a preview registry is missing or malformed", () => {
		for (const previewFunctionRegistryJson of [
			null,
			"{bad json",
			"{}",
			JSON.stringify({ " system/* ": { appId: "fn-system" } }),
		] as const) {
			expect(
				service({ preview: true, previewFunctionRegistryJson }).actionAvailability(
					"system/dapr-converse",
				),
			).toMatchObject({
				available: false,
				code: "unsupported_in_preview",
			});
		}
	});

	it("does not apply the preview registry outside a preview deployment", () => {
		expect(service().actionAvailability("github/create_issue")).toEqual({
			available: true,
			code: "available",
			message: null,
		});
	});

	it("derives social provider availability from complete server configuration", () => {
		const capabilities = service({
			github: { clientId: null, clientSecret: "secret" },
			google: { clientId: "id", clientSecret: null },
		});

		expect(capabilities.socialAuthReadModel()).toEqual({
			providers: [
				{ provider: "github", available: false, code: "not_configured" },
				{ provider: "google", available: false, code: "not_configured" },
			],
		});
		expect(capabilities.socialAuthAvailability("oidc")).toMatchObject({
			available: false,
			code: "unsupported",
		});
	});
});
