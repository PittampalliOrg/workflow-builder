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

function service(input: {
	preview?: boolean;
	github?: { clientId: string | null; clientSecret: string | null };
	google?: { clientId: string | null; clientSecret: string | null };
} = {}) {
	return new ApplicationDeploymentCapabilitiesService(
		new EnvironmentDeploymentCapabilityPolicyAdapter({
			previewDeployment: input.preview ? previewDeployment : null,
			socialAuth: {
				github: input.github ?? { clientId: "github-id", clientSecret: "github-secret" },
				google: input.google ?? { clientId: "google-id", clientSecret: "google-secret" },
			},
		}),
	);
}

describe("deployment capability policy", () => {
	it("excludes OpenShell preview actions and coordinator work from preview deployments", () => {
		const capabilities = service({ preview: true });

		expect(capabilities.actionAvailability("browser/start-preview")).toMatchObject({
			available: false,
			code: "unsupported_in_preview",
		});
		expect(capabilities.actionAvailability("browser/stop-preview")).toMatchObject({
			available: false,
			code: "unsupported_in_preview",
		});
		expect(capabilities.actionAvailability("github/create_issue")).toEqual({
			available: true,
			code: "available",
			message: null,
		});
		expect(
			capabilities.coordinatedWorkloadAvailability("benchmark"),
		).toMatchObject({ available: false, code: "unsupported_in_preview" });
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
