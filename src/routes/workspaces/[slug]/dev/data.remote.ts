import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { getApplicationAdapters } from '$lib/server/application';
import { PreviewEnvironmentLaunchAuthorizationError } from '$lib/server/application/preview-environment-launch-broker';
import { getApplicationAdapterConfig } from '$lib/server/application/config';
import { PreviewAccessDeniedError } from '$lib/server/application/preview-access';
import { PreviewTeardownRefusedError } from '$lib/server/application/preview-teardown';
import {
	PreviewEnvironmentRevisionResolutionError,
	PreviewEnvironmentUnavailableError,
	PreviewEnvironmentValidationError
} from '$lib/server/application/preview-environments';
import {
	PreviewEnvironmentDesiredStateError,
	PreviewEnvironmentDesiredStateOwnershipError
} from '$lib/server/application/ports';
import type { PreviewArchiveResult, PrPreviewStatus } from '$lib/server/application/ports';
import { safePreviewName, type VclusterPreviewTeardownTicket } from '$lib/types/dev-previews';
import type {
	PreviewSleepResult,
	PreviewWakeResult,
	PreviewEnvironmentLaunchRequest,
	PrPreviewListItem,
	VclusterLaunchResult,
	VclusterPreviewCounts,
	VclusterPreviewSummary
} from '$lib/types/dev-previews';
import type { DevEnvironmentGroupReadModel } from '$lib/server/application/ports';
import { requirePlatformAdmin } from '$lib/server/platform-admin';

/** Auth guard for the Dev-hub reads/mutations (mirrors the REST routes' 401). */
function requireSession() {
	const event = getRequestEvent();
	const session = event.locals.session;
	if (!session?.userId) error(401, 'Authentication required');
	return session;
}

async function requireAdminSession() {
	const event = getRequestEvent();
	const session = requireSession();
	await requirePlatformAdmin(event.locals);
	return session;
}

function requireControlPlaneDeployment() {
	if (!getApplicationAdapters().previewDeploymentScope.isControlPlane()) {
		error(403, 'Preview fleet operations are unavailable from a preview deployment');
	}
}

function requireDeploymentPreviewName(inputName: string): string {
	const scope = getApplicationAdapters().previewDeploymentScope;
	if (!scope.allowsPreviewName(inputName)) {
		error(403, 'Cross-preview access is unavailable from a preview deployment');
	}
	return safePreviewName(inputName);
}

function toPrPreviewListItem(s: PrPreviewStatus, repo: string): PrPreviewListItem {
	return {
		prNumber: s.prNumber,
		alias: s.alias,
		url: s.url,
		prUrl: `https://github.com/${repo}/pull/${s.prNumber}`,
		state: s.state,
		headSha: s.headSha,
		services: s.services,
		error: s.error,
		verify: s.verify
			? {
					state: s.verify.state,
					reason: s.verify.reason,
					verdict: s.verify.verdict
				}
			: null,
		updatedAt: s.updatedAt
	};
}

/** The dev environment grid (one entry per execution). */
export const getDevEnvironmentGroups = query(async (): Promise<DevEnvironmentGroupReadModel[]> => {
	const session = requireSession();
	return getApplicationAdapters().workflowData.listDevEnvironmentGroups({
		projectId: session.projectId ?? null
	});
});

/** Active Tier-2 vcluster previews + capacity counts (SEA-backed, list-only). */
export const getVclusterPreviews = query(
	async (): Promise<{
		previews: VclusterPreviewSummary[];
		counts: VclusterPreviewCounts | null;
	}> => {
		requireControlPlaneDeployment();
		await requireAdminSession();
		return getApplicationAdapters().vclusterPreviews.list();
	}
);

/**
 * Preview-local read. It returns the same view shape as the control-plane list
 * without placing any other preview or fleet-capacity record in candidate
 * browser state.
 */
export const getVclusterPreview = query(
	'unchecked',
	async (
		inputName: string
	): Promise<{
		previews: VclusterPreviewSummary[];
		counts: VclusterPreviewCounts | null;
	}> => {
		const session = requireSession();
		const name = requireDeploymentPreviewName(inputName);
		const adapters = getApplicationAdapters();
		try {
			const access = await adapters.previewAccess.authorize({
				name,
				actorUserId: session.userId
			});
			return {
				previews: [adapters.vclusterPreviews.present(access.preview)],
				counts: null
			};
		} catch (cause) {
			if (cause instanceof PreviewAccessDeniedError) error(403, cause.message);
			throw cause;
		}
	}
);

/**
 * D1 per-PR previews for the hub panel. STRICTLY the resume-safe
 * `listStatuses()` snapshot — a browser poll must never kick a pipeline. Off
 * (flag) → `{enabled:false}` so the panel renders its placeholder.
 */
export const getPrPreviews = query(
	async (): Promise<{ enabled: boolean; items: PrPreviewListItem[] }> => {
		requireControlPlaneDeployment();
		await requireAdminSession();
		const config = getApplicationAdapterConfig();
		if (!config.prPreviewsEnabled) return { enabled: false, items: [] };
		const statuses = await getApplicationAdapters().prPreviews.listStatuses();
		return {
			enabled: true,
			items: statuses.map((s) => toPrPreviewListItem(s, config.prPreviewRepo))
		};
	}
);

/** Launch a preview (claim-first, capacity-gated cold fallback). Refusal is data. */
export const launchPreview = command(
	'unchecked',
	async (input: PreviewEnvironmentLaunchRequest): Promise<VclusterLaunchResult> => {
		requireControlPlaneDeployment();
		const session = await requireAdminSession();
		const name = safePreviewName(input?.name ?? '');
		if (!name || name === 'preview') error(400, 'A preview name is required');
		const adapters = getApplicationAdapters();
		try {
			if (input.profile && input.profile !== 'app-live') {
				const pullRequestNumber = input.pullRequest?.number;
				if (!Number.isInteger(pullRequestNumber) || (pullRequestNumber ?? 0) < 1) {
					error(400, 'Infrastructure previews require a positive stacks pull request number');
				}
				const brokered = await adapters.previewInfrastructureCandidates.launch({
					requestId: globalThis.crypto.randomUUID(),
					name,
					userId: session.userId,
					pullRequestNumber: pullRequestNumber!,
					...(input.ttlHours === undefined ? {} : { ttlHours: input.ttlHours }),
					...(input.lifecycle === 'ephemeral' || input.lifecycle === 'retained'
						? { lifecycle: input.lifecycle }
						: {})
				});
				if (brokered.status === 'operator-required') {
					return {
						ok: false,
						reason: 'conflict',
						message: `${brokered.profile} requires the operator-controlled ${brokered.operatorAction.command} lane`
					};
				}
				return adapters.vclusterPreviews.presentLaunch(brokered.launch);
			}
			const outcome = await adapters.previewEnvironments.launchForUser({
				name,
				userId: session.userId,
				profile: input.profile,
				capabilities: input.capabilities,
				platformRevision: input.platformRevision,
				platformRef: input.platformRef,
				sourceRevision: input.sourceRevision,
				sourceRef: input.sourceRef,
				services: input.services,
				ttlHours: input.ttlHours,
				lifecycle: input.lifecycle,
				allocation: input.allocation,
				provenance:
					input.provenance?.parentEnvironmentId == null
						? undefined
						: {
								parentEnvironmentId: input.provenance.parentEnvironmentId
							}
			});
			return adapters.vclusterPreviews.presentLaunch(outcome);
		} catch (cause) {
			if (cause instanceof PreviewEnvironmentLaunchAuthorizationError) {
				error(403, cause.message);
			}
			if (cause instanceof PreviewEnvironmentValidationError) {
				error(400, cause.message);
			}
			if (cause instanceof PreviewEnvironmentRevisionResolutionError) {
				error(502, cause.message);
			}
			if (cause instanceof PreviewEnvironmentUnavailableError) {
				error(501, cause.message);
			}
			throw cause;
		}
	}
);

/** Sleep a preview (scale down). 409 → typed refusal (protected / pool-member). */
export const sleepPreview = command(
	'unchecked',
	async (input: { name: string }): Promise<PreviewSleepResult> => {
		requireControlPlaneDeployment();
		await requireAdminSession();
		return getApplicationAdapters().vclusterPreviews.sleep(input.name);
	}
);

/** Wake a slept preview (touch → resume Job). */
export const wakePreview = command(
	'unchecked',
	async (input: { name: string }): Promise<PreviewWakeResult> => {
		requireControlPlaneDeployment();
		await requireAdminSession();
		return getApplicationAdapters().vclusterPreviews.wake(input.name);
	}
);

/**
 * Tear down a preview. Mutable app-live data must be archived first; optional
 * archive failures on reconciled previews do not block teardown. Returns the
 * archive result so the UI can link to durable bundles.
 */
export const teardownPreview = command(
	'unchecked',
	async (input: {
		name: string;
		expectedRequestId: string;
		expectedSourceRevision: string;
		forceFailed?: boolean;
	}): Promise<{
		archive: PreviewArchiveResult | null;
		preview: VclusterPreviewSummary;
		teardown: VclusterPreviewTeardownTicket | null;
	}> => {
		requireControlPlaneDeployment();
		const session = await requireAdminSession();
		try {
			const adapters = getApplicationAdapters();
			const result = await adapters.previewTeardown.teardown({
				name: input.name,
				actorUserId: session.userId,
				expectedRequestId: input.expectedRequestId,
				expectedSourceRevision: input.expectedSourceRevision,
				projectId: session.projectId ?? null,
				...(input.forceFailed === true ? { forceFailed: true } : {})
			});
			return {
				archive: result.archive,
				preview: adapters.vclusterPreviews.present(result.preview),
				teardown: result.ticket
			};
		} catch (cause) {
			if (cause instanceof PreviewAccessDeniedError) error(403, cause.message);
			if (cause instanceof PreviewTeardownRefusedError) error(409, cause.message);
			if (cause instanceof PreviewEnvironmentDesiredStateOwnershipError) error(409, cause.message);
			if (cause instanceof PreviewEnvironmentDesiredStateError) error(503, cause.message);
			throw cause;
		}
	}
);
