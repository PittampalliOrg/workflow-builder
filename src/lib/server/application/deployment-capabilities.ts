import type {
	CoordinatedWorkload,
	DeploymentCapabilityAvailability,
	DeploymentCapabilityPolicyPort,
	SocialAuthProvider,
} from "$lib/server/application/ports";

export class ApplicationDeploymentCapabilitiesService {
	constructor(private readonly policy: DeploymentCapabilityPolicyPort) {}

	actionAvailability(slug: string): DeploymentCapabilityAvailability {
		return this.policy.availability({ kind: "action", slug: slug.trim() });
	}

	socialAuthAvailability(provider: string): DeploymentCapabilityAvailability {
		return this.policy.availability({
			kind: "social-auth",
			provider: provider.trim().toLowerCase(),
		});
	}

	coordinatedWorkloadAvailability(
		workload: CoordinatedWorkload,
	): DeploymentCapabilityAvailability {
		return this.policy.availability({ kind: "coordinated-workload", workload });
	}

	socialAuthReadModel(): {
		providers: Array<{
			provider: SocialAuthProvider;
			available: boolean;
			code: DeploymentCapabilityAvailability["code"];
		}>;
	} {
		return {
			providers: (["github", "google"] as const).map((provider) => {
				const availability = this.socialAuthAvailability(provider);
				return {
					provider,
					available: availability.available,
					code: availability.code,
				};
			}),
		};
	}
}
