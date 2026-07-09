import { env } from "$env/dynamic/private";

export const APP_PROFILES = ["full", "lite"] as const;
export const PERSISTENCE_ADAPTERS = ["postgres"] as const;
export const EVENT_BUS_ADAPTERS = ["dapr-pubsub", "in-process"] as const;
export const ARTIFACT_STORE_ADAPTERS = ["postgres-metadata-object-data"] as const;
export const WORKFLOW_SCHEDULER_ADAPTERS = ["dapr-workflow", "lite-stub"] as const;
export const PREVIEW_PROVISIONER_ADAPTERS = ["sandbox-execution-api", "kro"] as const;
export const SCRIPT_CALLS_STORE_ADAPTERS = ["postgres", "dapr-postgres-binding"] as const;

export type AppProfile = (typeof APP_PROFILES)[number];
export type PersistenceAdapter = (typeof PERSISTENCE_ADAPTERS)[number];
export type EventBusAdapter = (typeof EVENT_BUS_ADAPTERS)[number];
export type ArtifactStoreAdapter = (typeof ARTIFACT_STORE_ADAPTERS)[number];
export type WorkflowSchedulerAdapter = (typeof WORKFLOW_SCHEDULER_ADAPTERS)[number];
export type PreviewProvisionerAdapter = (typeof PREVIEW_PROVISIONER_ADAPTERS)[number];
export type ScriptCallsStoreAdapter = (typeof SCRIPT_CALLS_STORE_ADAPTERS)[number];

export type ApplicationAdapterConfig = {
	appProfile: AppProfile;
	persistenceAdapter: PersistenceAdapter;
	eventBusAdapter: EventBusAdapter;
	artifactStoreAdapter: ArtifactStoreAdapter;
	workflowSchedulerAdapter: WorkflowSchedulerAdapter;
	previewProvisionerAdapter: PreviewProvisionerAdapter;
	scriptCallsStoreAdapter: ScriptCallsStoreAdapter;
	/** E1: the Dev-hub live preview run feed. Off by default. */
	previewRunFeedEnabled: boolean;
	/** D1: label-gated per-PR previews (`/api/internal/pr-previews`). Off by default. */
	prPreviewsEnabled: boolean;
	/** D1: repo slug for building PR URLs in UI reads (PR_PREVIEW_REPO). */
	prPreviewRepo: string;
	/** Awake-preview capacity for UI meters (mirrors SEA VCLUSTER_PREVIEW_MAX). */
	vclusterPreviewMax: number;
	/** D2: dispatch the Playwright-critic verify pass on a ready PR preview. Off by default. */
	prPreviewVerifyEnabled: boolean;
	/** D2: Promote adds the `preview` label to the PRs it opens. Off by default. */
	promoteAutoPreviewLabel: boolean;
	/** E2: the Dev-hub read proxy into preview BFF run history. Off by default. */
	previewReadProxyEnabled: boolean;
	/** E3: archive run summaries + un-promoted bundles before vcluster teardown. Off by default. */
	previewArchiveOnTeardownEnabled: boolean;
};

export function readFlag(
	source: Record<string, string | undefined>,
	key: string,
	fallback = false,
): boolean {
	const raw = source[key]?.trim().toLowerCase();
	if (!raw) return fallback;
	return ["1", "true", "yes", "on"].includes(raw);
}

export function readAdapter<T extends string>(
	source: Record<string, string | undefined>,
	key: string,
	fallback: T,
	supported: readonly T[],
): T {
	const raw = source[key]?.trim();
	if (!raw) return fallback;
	if ((supported as readonly string[]).includes(raw)) return raw as T;
	throw new Error(
		`Unsupported ${key}='${raw}'. Supported values: ${supported.join(", ")}`,
	);
}

function readProfile(source: Record<string, string | undefined>): AppProfile {
	const raw = source.APP_PROFILE?.trim().toLowerCase();
	if (!raw) return "full";
	if ((APP_PROFILES as readonly string[]).includes(raw)) return raw as AppProfile;
	throw new Error(
		`Unsupported APP_PROFILE='${raw}'. Supported values: ${APP_PROFILES.join(", ")}`,
	);
}

export function getApplicationAdapterConfig(
	source: Record<string, string | undefined> = env,
): ApplicationAdapterConfig {
	const appProfile = readProfile(source);
	// The lite profile flips the two Dapr-coupled families to their in-process
	// members by default (no cluster). Explicit env still wins, unknown values
	// still throw, and every other family (persistence, artifact store) is
	// unchanged — the PGlite driver handles persistence in lite. The full
	// profile keeps the byte-identical production defaults.
	const eventBusFallback: EventBusAdapter =
		appProfile === "lite" ? "in-process" : "dapr-pubsub";
	const workflowSchedulerFallback: WorkflowSchedulerAdapter =
		appProfile === "lite" ? "lite-stub" : "dapr-workflow";
	return {
		appProfile,
		persistenceAdapter: readAdapter(
			source,
			"PERSISTENCE_ADAPTER",
			"postgres",
			PERSISTENCE_ADAPTERS,
		),
		eventBusAdapter: readAdapter(
			source,
			"EVENT_BUS_ADAPTER",
			eventBusFallback,
			EVENT_BUS_ADAPTERS,
		),
		artifactStoreAdapter: readAdapter(
			source,
			"ARTIFACT_STORE_ADAPTER",
			"postgres-metadata-object-data",
			ARTIFACT_STORE_ADAPTERS,
		),
		workflowSchedulerAdapter: readAdapter(
			source,
			"WORKFLOW_SCHEDULER_ADAPTER",
			workflowSchedulerFallback,
			WORKFLOW_SCHEDULER_ADAPTERS,
		),
		previewProvisionerAdapter: readAdapter(
			source,
			"PREVIEW_PROVISIONER_ADAPTER",
			"sandbox-execution-api",
			PREVIEW_PROVISIONER_ADAPTERS,
		),
		scriptCallsStoreAdapter: readAdapter(
			source,
			"SCRIPT_CALLS_STORE_ADAPTER",
			"postgres",
			SCRIPT_CALLS_STORE_ADAPTERS,
		),
		previewRunFeedEnabled: readFlag(source, "PREVIEW_RUN_FEED_ENABLED"),
		prPreviewsEnabled: readFlag(source, "PR_PREVIEWS_ENABLED"),
		prPreviewRepo: source.PR_PREVIEW_REPO?.trim() || "PittampalliOrg/workflow-builder",
		vclusterPreviewMax: Number.parseInt(source.VCLUSTER_PREVIEW_MAX ?? "", 10) || 6,
		prPreviewVerifyEnabled: readFlag(source, "PR_PREVIEW_VERIFY_ENABLED"),
		promoteAutoPreviewLabel: readFlag(source, "PROMOTE_AUTO_PREVIEW_LABEL"),
		previewReadProxyEnabled: readFlag(source, "PREVIEW_READ_PROXY_ENABLED"),
		previewArchiveOnTeardownEnabled: readFlag(
			source,
			"PREVIEW_ARCHIVE_ON_TEARDOWN",
		),
	};
}
