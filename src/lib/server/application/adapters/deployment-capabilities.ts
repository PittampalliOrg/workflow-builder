import type {
	DeploymentCapabilityAvailability,
	DeploymentCapabilityPolicyPort,
	DeploymentCapabilityQuery,
	PreviewDeploymentDescriptor,
	SocialAuthProvider,
} from "$lib/server/application/ports";

const AVAILABLE: DeploymentCapabilityAvailability = Object.freeze({
	available: true,
	code: "available",
	message: null,
});

type SocialAuthConfiguration = Record<
	SocialAuthProvider,
	Readonly<{ clientId: string | null; clientSecret: string | null }>
>;

type PreviewFunctionRegistry = ReadonlySet<string>;

function parsePreviewNativeActionSlugs(
	value: string | null | undefined,
): ReadonlySet<string> {
	if (!value?.trim()) return new Set();
	try {
		const parsed = JSON.parse(value) as unknown;
		if (
			!Array.isArray(parsed) ||
			parsed.some(
				(slug) =>
					typeof slug !== "string" ||
					!slug ||
					slug !== slug.trim() ||
					!slug.includes("/"),
			)
		) {
			return new Set();
		}
		return new Set(parsed);
	} catch {
		return new Set();
	}
}

function parsePreviewFunctionRegistry(
	value: string | null | undefined,
): PreviewFunctionRegistry | null {
	if (!value?.trim()) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		const entries = Object.entries(parsed as Record<string, unknown>);
		if (
			entries.length === 0 ||
			entries.some(
				([route, target]) =>
					!route ||
					route !== route.trim() ||
					!target ||
					typeof target !== "object" ||
					Array.isArray(target),
			)
		) {
			return null;
		}
		return new Set(entries.map(([route]) => route));
	} catch {
		return null;
	}
}

function registryAllows(registry: PreviewFunctionRegistry, slug: string): boolean {
	const plugin = slug.split("/", 1)[0];
	return (
		registry.has(slug) ||
		(Boolean(plugin) && registry.has(`${plugin}/*`)) ||
		registry.has("_default")
	);
}

export class EnvironmentDeploymentCapabilityPolicyAdapter
	implements DeploymentCapabilityPolicyPort
{
	private readonly previewFunctionRegistry: PreviewFunctionRegistry | null;
	private readonly previewNativeActionSlugs: ReadonlySet<string>;

	constructor(
		private readonly config: Readonly<{
			previewDeployment: PreviewDeploymentDescriptor | null;
			previewFunctionRegistryJson?: string | null;
			previewNativeActionSlugsJson?: string | null;
			socialAuth: SocialAuthConfiguration;
		}>,
	) {
		this.previewFunctionRegistry = parsePreviewFunctionRegistry(
			config.previewFunctionRegistryJson,
		);
		this.previewNativeActionSlugs = parsePreviewNativeActionSlugs(
			config.previewNativeActionSlugsJson,
		);
	}

	availability(
		query: DeploymentCapabilityQuery,
	): DeploymentCapabilityAvailability {
		if (query.kind === "action") {
			if (
				this.config.previewDeployment &&
				this.previewNativeActionSlugs.has(query.slug)
			) {
				return AVAILABLE;
			}
			if (this.config.previewDeployment && !this.previewFunctionRegistry) {
				return unavailable(
					"unsupported_in_preview",
					`${query.slug} is unavailable because this preview has no valid strict function registry`,
				);
			}
			if (
				this.config.previewDeployment &&
				this.previewFunctionRegistry &&
				!registryAllows(this.previewFunctionRegistry, query.slug)
			) {
				return unavailable(
					"unsupported_in_preview",
					`${query.slug} is unavailable because it is absent from this preview's strict function registry`,
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
