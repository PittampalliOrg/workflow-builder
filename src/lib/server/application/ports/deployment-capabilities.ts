export const SOCIAL_AUTH_PROVIDERS = ["github", "google"] as const;

export type SocialAuthProvider = (typeof SOCIAL_AUTH_PROVIDERS)[number];
export type CoordinatedWorkload = "benchmark" | "evaluation";

export type DeploymentCapabilityQuery =
	| { kind: "action"; slug: string }
	| { kind: "social-auth"; provider: string }
	| { kind: "coordinated-workload"; workload: CoordinatedWorkload };

export type DeploymentCapabilityAvailability = Readonly<{
	available: boolean;
	code:
		| "available"
		| "unsupported"
		| "unsupported_in_preview"
		| "not_configured";
	message: string | null;
}>;

/** Server-authoritative policy source for capabilities that vary by deployment. */
export interface DeploymentCapabilityPolicyPort {
	availability(query: DeploymentCapabilityQuery): DeploymentCapabilityAvailability;
}
