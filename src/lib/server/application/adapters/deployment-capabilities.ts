import type {
	DeploymentCapabilityAvailability,
	DeploymentCapabilityPolicyPort,
	DeploymentCapabilityQuery,
	PreviewDeploymentDescriptor,
	SocialAuthProvider,
} from "$lib/server/application/ports";

const BROWSER_PREVIEW_ACTIONS = new Set([
	"browser/start-preview",
	"browser/stop-preview",
]);

const AVAILABLE: DeploymentCapabilityAvailability = Object.freeze({
	available: true,
	code: "available",
	message: null,
});

type SocialAuthConfiguration = Record<
	SocialAuthProvider,
	Readonly<{ clientId: string | null; clientSecret: string | null }>
>;

export class EnvironmentDeploymentCapabilityPolicyAdapter
	implements DeploymentCapabilityPolicyPort
{
	constructor(
		private readonly config: Readonly<{
			previewDeployment: PreviewDeploymentDescriptor | null;
			socialAuth: SocialAuthConfiguration;
		}>,
	) {}

	availability(
		query: DeploymentCapabilityQuery,
	): DeploymentCapabilityAvailability {
		if (query.kind === "action") {
			if (
				this.config.previewDeployment &&
				BROWSER_PREVIEW_ACTIONS.has(query.slug)
			) {
				return unavailable(
					"unsupported_in_preview",
					`${query.slug} is unavailable in preview deployments because the OpenShell workspace runtime is not part of the preview service surface`,
				);
			}
			return AVAILABLE;
		}

		if (query.kind === "social-auth") {
			if (query.provider !== "github" && query.provider !== "google") {
				return unavailable(
					"unsupported",
					`Social auth provider '${query.provider}' is unsupported`,
				);
			}
			const provider = query.provider as SocialAuthProvider;
			const configured = this.config.socialAuth[provider];
			if (!configured.clientId || !configured.clientSecret) {
				return unavailable(
					"not_configured",
					`${provider} social auth is not configured for this deployment`,
				);
			}
			return AVAILABLE;
		}

		if (this.config.previewDeployment) {
			return unavailable(
				"unsupported_in_preview",
				`${query.workload} coordinators are unavailable in preview deployments; submit this work through the dev control plane`,
			);
		}
		return AVAILABLE;
	}
}

function unavailable(
	code: Exclude<DeploymentCapabilityAvailability["code"], "available">,
	message: string,
): DeploymentCapabilityAvailability {
	return Object.freeze({ available: false, code, message });
}
