/**
 * Host-side commands against a retained preview's Phase-1 lifecycle endpoints
 * (shipping in PR feat/preview-retained-ux, preview-local BFF routes):
 *
 *   POST {previewBff}/api/internal/workflows/executions/{executionId}/dev-preview/release
 *     Auth: INTERNAL_API_TOKEN (`x-internal-token`, host->preview control path)
 *           or PREVIEW_ACTION_INTERNAL_TOKEN (`x-preview-action-token`).
 *     Releases the execution's dev-preview Sandboxes (restores adopted prod
 *     Deployments); the retained environment stays up. 404 = no dev previews.
 *
 *   POST {previewBff}/api/internal/workflows/executions/{executionId}/dev-preview/freeze
 *     Auth: PREVIEW_ACTION_INTERNAL_TOKEN only (`x-preview-action-token`).
 *     Freezes live-sync source receivers without tearing anything down.
 *
 * Routing reuses the existing host->preview base-URL resolution
 * (`previewApiBaseUrl`: synced in-cluster Service first, tailnet fallback).
 * Anything not reachable yet — missing endpoint, missing credential, no
 * associated execution — returns `reason: "unsupported"` as data.
 */
import { env } from "$env/dynamic/private";
import { getApplicationAdapters } from "$lib/server/application";
import { previewApiBaseUrl } from "$lib/server/application/adapters/preview-read-proxy";
import { listPromotionReceiptsForPreviews } from "$lib/server/dev-hub/promotion-receipts";
import type {
	PreviewRetentionActionResult,
	VclusterPreviewSummary,
} from "$lib/types/dev-previews";

const REQUEST_TIMEOUT_MS = 30_000;

type FetchLike = typeof fetch;

function unsupported(message: string): PreviewRetentionActionResult {
	return { ok: false, reason: "unsupported", message };
}

function failed(message: string): PreviewRetentionActionResult {
	return { ok: false, reason: "error", message };
}

function readEnv(name: string): string | null {
	const value = (env as Record<string, string | undefined>)[name] ?? process.env[name];
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

/**
 * Resolve the execution id whose dev-preview session rows live inside the
 * preview: prefer the non-user owner id (workflow/session-launched previews),
 * then an explicit provenance executionId, then the newest promotion receipt.
 */
async function resolveExecutionId(
	preview: VclusterPreviewSummary,
): Promise<string | null> {
	if (preview.owner && preview.owner.kind !== "user" && preview.owner.id) {
		return preview.owner.id;
	}
	const provenanceExecution = preview.provenance?.executionId;
	if (typeof provenanceExecution === "string" && provenanceExecution.trim()) {
		return provenanceExecution.trim();
	}
	const { executionIdsByPreview } = await listPromotionReceiptsForPreviews([
		preview.name,
	]);
	return executionIdsByPreview.get(preview.name)?.[0] ?? null;
}

type PreviewCallTarget = {
	preview: VclusterPreviewSummary;
	baseUrl: string;
	executionId: string;
};

async function resolveTarget(
	previewName: string,
): Promise<PreviewCallTarget | PreviewRetentionActionResult> {
	const adapters = getApplicationAdapters();
	let preview: VclusterPreviewSummary;
	try {
		preview = await adapters.vclusterPreviews.get(previewName);
	} catch (cause) {
		return failed(
			cause instanceof Error ? cause.message : `preview ${previewName} was not readable`,
		);
	}
	if (preview.phase === "absent") {
		return failed(`preview ${previewName} does not exist`);
	}
	if (preview.state === "slept") {
		return unsupported(
			`preview ${previewName} is slept; wake it before managing its dev leases`,
		);
	}
	const baseUrl = previewApiBaseUrl({
		name: preview.name,
		url: preview.url,
		pool: preview.pool,
	});
	if (!baseUrl) {
		return unsupported(
			`no host->preview route is available for ${previewName} yet`,
		);
	}
	const executionId = await resolveExecutionId(preview);
	if (!executionId) {
		return unsupported(
			`no execution is associated with preview ${previewName}; nothing to release or freeze`,
		);
	}
	return { preview, baseUrl, executionId };
}

function isResult(
	value: PreviewCallTarget | PreviewRetentionActionResult,
): value is PreviewRetentionActionResult {
	return "ok" in value;
}

async function postPreviewLifecycle(input: {
	target: PreviewCallTarget;
	path: "release" | "freeze";
	headers: Record<string, string>;
	body: Record<string, unknown>;
	fetchImpl?: FetchLike;
}): Promise<PreviewRetentionActionResult> {
	const url = `${input.target.baseUrl.replace(/\/+$/, "")}/api/internal/workflows/executions/${encodeURIComponent(
		input.target.executionId,
	)}/dev-preview/${input.path}`;
	let response: Response;
	try {
		response = await (input.fetchImpl ?? fetch)(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...input.headers },
			body: JSON.stringify(input.body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (cause) {
		return failed(
			`preview ${input.path} request failed: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
		);
	}

	const body = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	const detail =
		typeof body?.error === "string"
			? body.error
			: typeof body?.skipped === "string"
				? body.skipped
				: null;

	if (response.status === 404) {
		// Either the execution has no dev previews, or the preview's BFF image
		// predates the Phase-1 endpoint. Both are "nothing to act on here yet".
		return unsupported(
			detail ?? `the preview does not support dev-preview ${input.path} yet`,
		);
	}
	if (response.ok) {
		if (body && body.ok === false) {
			return unsupported(
				detail ?? `dev-preview ${input.path} was skipped by the preview`,
			);
		}
		return { ok: true };
	}
	return failed(
		detail ?? `dev-preview ${input.path} returned HTTP ${response.status}`,
	);
}

/** Release a retained preview's dev-preview Sandboxes (undo the dev adoption). */
export async function releaseRetainedDevLease(
	input: { previewName: string },
	options?: { fetchImpl?: FetchLike },
): Promise<PreviewRetentionActionResult> {
	const target = await resolveTarget(input.previewName);
	if (isResult(target)) return target;

	const actionToken = readEnv("PREVIEW_ACTION_INTERNAL_TOKEN");
	const internalToken = readEnv("INTERNAL_API_TOKEN");
	if (!actionToken && !internalToken) {
		return unsupported(
			"no preview lifecycle credential is configured on this deployment",
		);
	}
	return postPreviewLifecycle({
		target,
		path: "release",
		headers: actionToken
			? { "x-preview-action-token": actionToken }
			: { "x-internal-token": internalToken! },
		body: {},
		fetchImpl: options?.fetchImpl,
	});
}

/** Freeze a retained preview's live-sync source receivers (sources become immutable). */
export async function freezeRetainedPreviewSources(
	input: { previewName: string },
	options?: { fetchImpl?: FetchLike },
): Promise<PreviewRetentionActionResult> {
	const target = await resolveTarget(input.previewName);
	if (isResult(target)) return target;

	const actionToken = readEnv("PREVIEW_ACTION_INTERNAL_TOKEN");
	if (!actionToken) {
		return unsupported(
			"PREVIEW_ACTION_INTERNAL_TOKEN is not configured on this deployment",
		);
	}
	return postPreviewLifecycle({
		target,
		path: "freeze",
		headers: { "x-preview-action-token": actionToken },
		body: {},
		fetchImpl: options?.fetchImpl,
	});
}
