import {
	devPreviewBrowseUrl,
	devPreviewTailnetHost,
	DEV_PREVIEW_SERVICES,
	resolveDevPreviewDescriptor,
} from "$lib/server/workflows/dev-preview-registry";

/**
 * Read model for the Dev hub. A "dev environment" = a per-run dev-preview pod
 * (a `workflow_workspace_sessions` row with `details.kind='dev-preview'`) plus
 * the interactive coding-agent session the run handed off into (linked via
 * `sessions.workflow_execution_id`). Both are produced by the
 * `microservice-dev-session` workflow; the hub only READS them back here.
 */
export interface DevEnvironmentSummary {
	executionId: string;
	workspaceRef: string;
	service: string;
	browseUrl: string | null;
	podIP: string | null;
	port: number | null;
	syncUrl: string | null;
	ready: boolean;
	needsDapr: boolean;
	daprAppId: string | null;
	sandboxName: string | null;
	sessionId: string | null;
	sessionUrl: string | null;
	runStatus: string | null;
	createdAt: string;
}

export type PreviewDetails = {
	kind?: string;
	executionId?: string;
	service?: string;
	browseUrl?: string | null;
	podIP?: string | null;
	port?: number | null;
	syncUrl?: string | null;
	ready?: boolean;
	needsDapr?: boolean;
	daprAppId?: string | null;
	sandboxName?: string | null;
};

export function detailsOf(sandboxState: unknown): PreviewDetails | null {
	const details = (sandboxState as { details?: PreviewDetails } | null)?.details;
	return details && typeof details === "object" ? details : null;
}

/** Reconstruct the human-browsable tailnet URL when an older row lacks it. */
export function browseUrlFor(
	service: string,
	stored: string | null | undefined,
): string | null {
	if (stored) return stored;
	const d = DEV_PREVIEW_SERVICES[service];
	return d ? devPreviewBrowseUrl(d) : null;
}

/** Public, credential-free catalog of launchable services for the UI dropdown. */
export function devPreviewServiceCatalog() {
	return Object.values(DEV_PREVIEW_SERVICES).map((d) => ({
		service: d.service,
		primaryCluster: "dev",
		previewTier: "tier-1-hot-loop",
		needsDapr: d.needsDapr === true,
		port: d.port,
		syncMode: d.syncMode,
		repoUrl: d.repoUrl,
		repoSubdir: d.repoSubdir,
		tailnetHost: devPreviewTailnetHost(d),
	}));
}

export { resolveDevPreviewDescriptor };
