import { readFileSync } from "node:fs";
import { env } from "$env/dynamic/private";
import type {
	PreviewEnvironmentCandidatePathPolicyPort,
	PreviewEnvironmentCandidatePathRoute,
	PreviewEnvironmentCandidatePathRoutingPort,
} from "$lib/server/application/ports";

type SurfaceContract = Readonly<{
	schemaVersion: 1;
	profile: "manifest-candidate";
	allowedSurfaces: readonly Readonly<{ pathPrefix: string; renderer: string }>[];
	routeRules: readonly Readonly<{
		pathPrefix: string;
		profile: "manifest-candidate" | "host-candidate";
		lane: "application" | "management";
		reason: string;
	}>[];
}>;

export type ManifestCandidatePathPolicyOptions = Readonly<{
	contract?: SurfaceContract;
	path?: () => string;
}>;

/** Enforces the mounted stacks-owned executable surface contract. */
export class ManifestCandidatePathPolicyAdapter
	implements
		PreviewEnvironmentCandidatePathPolicyPort,
		PreviewEnvironmentCandidatePathRoutingPort
{
	private contract: SurfaceContract | null = null;

	constructor(private readonly options: ManifestCandidatePathPolicyOptions = {}) {}

	assertManifestCandidatePaths(paths: readonly string[]): readonly string[] {
		const routed = this.routeCandidatePaths(paths);
		if (
			routed.profile !== "manifest-candidate" ||
			routed.lane !== "application"
		) {
			throw new Error(
				`candidate paths require ${routed.profile} lane ${routed.lane}, not the application manifest-candidate lane`,
			);
		}
		return routed.paths;
	}

	routeCandidatePaths(
		paths: readonly string[],
	): PreviewEnvironmentCandidatePathRoute {
		const contract = this.load();
		const normalized = [...new Set(paths)].sort();
		if (normalized.length === 0) throw new Error("candidate PR has no changed paths");
		if (normalized.length > 64) {
			throw new Error("candidate PR exceeds the 64-path PreviewEnvironment bound");
		}
		const routes = new Map<string, Pick<PreviewEnvironmentCandidatePathRoute, "profile" | "lane">>();
		for (const path of normalized) {
			const route = contract.routeRules.find((entry) =>
				matches(path, entry.pathPrefix),
			);
			if (route) {
				routes.set(`${route.profile}:${route.lane}`, {
					profile: route.profile,
					lane: route.lane,
				});
				continue;
			}
			if (
				contract.allowedSurfaces.some((entry) =>
					matches(path, entry.pathPrefix),
				)
			) {
				routes.set("manifest-candidate:application", {
					profile: "manifest-candidate",
					lane: "application",
				});
				continue;
			}
			throw new Error(
				`candidate path ${path} is outside the executable preview surface`,
			);
		}
		if (routes.size !== 1) {
			throw new Error(
				`candidate PR spans multiple preview lanes: ${[...routes.keys()].sort().join(", ")}`,
			);
		}
		const route = [...routes.values()][0]!;
		return Object.freeze({
			...route,
			paths: Object.freeze(normalized),
		});
	}

	private load(): SurfaceContract {
		if (this.contract) return this.contract;
		const raw = this.options.contract ?? JSON.parse(readFileSync(this.path(), "utf8"));
		if (
			!raw ||
			raw.schemaVersion !== 1 ||
			raw.profile !== "manifest-candidate" ||
			!Array.isArray(raw.allowedSurfaces) ||
			raw.allowedSurfaces.length === 0 ||
			!Array.isArray(raw.routeRules)
		) {
			throw new Error("manifest candidate surface contract is invalid");
		}
		for (const entry of [...raw.allowedSurfaces, ...raw.routeRules]) {
			if (!entry || typeof entry.pathPrefix !== "string" || !entry.pathPrefix) {
				throw new Error("manifest candidate surface contract contains an invalid pathPrefix");
			}
		}
		for (const entry of raw.routeRules) {
			if (
				(entry.profile === "manifest-candidate" && entry.lane !== "management") ||
				(entry.profile === "host-candidate" && entry.lane !== "application")
			) {
				throw new Error("manifest candidate surface contract contains an invalid route lane");
			}
		}
		this.contract = raw;
		return raw;
	}

	private path(): string {
		return (
			this.options.path?.() ??
			env.PREVIEW_MANIFEST_CANDIDATE_SURFACE_PATH ??
			process.env.PREVIEW_MANIFEST_CANDIDATE_SURFACE_PATH ??
			"/config/manifest-candidate-surface.json"
		);
	}
}

function matches(path: string, prefix: string): boolean {
	return prefix.endsWith("/")
		? path.startsWith(prefix)
		: path === prefix || path.startsWith(`${prefix}/`);
}
