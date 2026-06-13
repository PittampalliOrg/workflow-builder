/**
 * Per-piece runtime image lifecycle (docs/per-piece-runtime-images.md).
 *
 * A per-piece image `ghcr.io/<org>/ap-piece-<name>:<version>` is the converged
 * piece-runtime built FROM `piece-runtime-base` + exactly ONE Activepieces piece,
 * so memory is bounded to that piece (~256Mi) instead of the 48-piece bundle.
 *
 * The image is GLOBAL (GHCR), so we split:
 *   - BUILD   — once per piece+version, on hub Tekton (heavy, needs GHCR push creds).
 *   - ENABLE  — per-cluster, just a `piece_images` row + an `available_only` flip;
 *               INSTANT when the image already exists in GHCR (second cluster, re-enable).
 *
 * `enablePiece()` is the single orchestration used by BOTH the admin REST endpoint
 * and the admin pieces page form action. The build-completion callback flows back
 * through `recordImageResult()` (the internal image-registration endpoint).
 */
import { createHmac } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { pieceImages, pieceMetadata, platformDisabledPieces } from '$lib/server/db/schema';

const GHCR_ORG = (env.PIECE_IMAGE_GHCR_ORG || 'pittampalliorg').toLowerCase();
const GHCR_REPO_PREFIX = env.PIECE_IMAGE_REPO_PREFIX || 'ap-piece';
const GHCR_TOKEN_USER = env.PIECE_IMAGE_GHCR_USER || GHCR_ORG;

// Catalog slug == K8s service name fragment: lowercase alnum + dashes. The build
// pipeline hardcodes the npm package as `@activepieces/piece-<slug>`, so a valid
// slug can only ever install an Activepieces piece — this is the security boundary.
const PIECE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidPieceSlug(name: string): boolean {
	return PIECE_SLUG_RE.test(name);
}

/** `<org>/ap-piece-<name>` (no registry host, no tag). */
export function pieceImageRepo(pieceName: string): string {
	return `${GHCR_ORG}/${GHCR_REPO_PREFIX}-${pieceName}`;
}

/** Fully-qualified `ghcr.io/<org>/ap-piece-<name>:<version>`. */
export function pieceImageRef(pieceName: string, version: string): string {
	return `ghcr.io/${pieceImageRepo(pieceName)}:${version}`;
}

export type PieceImageStatus = 'building' | 'ready' | 'failed';

export interface EnableResult {
	pieceName: string;
	version: string;
	status: PieceImageStatus;
	image?: string;
	digest?: string;
	/** True when ENABLE flipped the catalog metadata so the reconciler will provision it. */
	madeRunnable: boolean;
	build?: { triggered: boolean; status?: number; reason?: string };
}

/**
 * GHCR registry-v2 existence check. ap-piece-* packages are PRIVATE, so we mint an
 * authenticated pull token from GITHUB_TOKEN (read:packages) and HEAD the manifest.
 * Returns the content digest when present so the ready row records an immutable ref.
 */
export async function ghcrImageExists(
	pieceName: string,
	version: string
): Promise<{ exists: boolean; digest?: string }> {
	const repo = pieceImageRepo(pieceName);
	const ght = env.GITHUB_TOKEN;
	try {
		const tokenHeaders: Record<string, string> = {};
		if (ght) {
			tokenHeaders.Authorization =
				'Basic ' + Buffer.from(`${GHCR_TOKEN_USER}:${ght}`).toString('base64');
		}
		const tokenRes = await fetch(
			`https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull`,
			{ headers: tokenHeaders, signal: AbortSignal.timeout(8000) }
		);
		if (!tokenRes.ok) return { exists: false };
		const token = (await tokenRes.json())?.token as string | undefined;
		if (!token) return { exists: false };

		const manifestRes = await fetch(
			`https://ghcr.io/v2/${repo}/manifests/${encodeURIComponent(version)}`,
			{
				method: 'HEAD',
				headers: {
					Authorization: `Bearer ${token}`,
					Accept:
						'application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.manifest.v1+json'
				},
				signal: AbortSignal.timeout(8000)
			}
		);
		if (manifestRes.status === 200) {
			return { exists: true, digest: manifestRes.headers.get('docker-content-digest') ?? undefined };
		}
		return { exists: false };
	} catch {
		// Network/registry hiccup — treat as "not known to exist" so ENABLE falls through
		// to the build path rather than silently doing nothing.
		return { exists: false };
	}
}

/** POST the hub Tekton per-piece build EventListener. Best-effort: a missing trigger
 *  URL leaves the `building` row in place (a later re-enable, once the URL is wired or
 *  the image exists, completes it). */
export async function triggerPieceImageBuild(args: {
	pieceName: string;
	pieceVersion: string;
	callbackUrl: string;
}): Promise<{ triggered: boolean; status?: number; reason?: string }> {
	const elUrl = env.PIECE_BUILD_TRIGGER_URL;
	if (!elUrl) return { triggered: false, reason: 'PIECE_BUILD_TRIGGER_URL not configured' };
	const secret = env.PIECE_BUILD_TRIGGER_SECRET;
	if (!secret) return { triggered: false, reason: 'PIECE_BUILD_TRIGGER_SECRET not configured' };
	try {
		// The hub Tekton perpiece-build EventListener validates the body with the Tekton
		// `github` interceptor, so we sign exactly the bytes we send and present the digest
		// as `X-Hub-Signature-256: sha256=<hex>` (GitHub webhook signature format).
		const body = JSON.stringify({
			pieceName: args.pieceName,
			pieceVersion: args.pieceVersion,
			callbackUrl: args.callbackUrl,
			gitSha: env.PIECE_BUILD_GIT_SHA || 'main'
		});
		const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
		const res = await fetch(elUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Hub-Signature-256': signature,
				// Tekton's github interceptor accepts any event type when eventTypes is unset;
				// send a stable custom type for log/audit clarity.
				'X-GitHub-Event': 'perpiece-build'
			},
			body,
			signal: AbortSignal.timeout(10000)
		});
		return { triggered: res.ok, status: res.status };
	} catch (err) {
		return { triggered: false, reason: err instanceof Error ? err.message : 'trigger failed' };
	}
}

/**
 * Make an enabled piece provisionable by the reconciler. The provision SIGNAL is the
 * ready+enabled `piece_images` row itself (the reconciler keys off it for available_only
 * pieces) — we deliberately do NOT flip `piece_metadata.available_only`, because the
 * metadata-sync owns that column as "bundle membership" and reverts any flip on its next
 * run (docs/per-piece-runtime-images.md). This only clears any platform disable
 * (blocklist) row so a previously-disabled piece can be re-enabled. Safe to call repeatedly.
 */
export async function markPieceRunnable(pieceName: string): Promise<void> {
	if (!db) return;
	await db.delete(platformDisabledPieces).where(eq(platformDisabledPieces.pieceName, pieceName));
}

/** Upsert a `building` row (enable-intent recorded via enabledAt). */
async function markBuilding(pieceName: string, version: string): Promise<void> {
	if (!db) return;
	await db
		.insert(pieceImages)
		.values({ pieceName, version, status: 'building', enabledAt: sql`now()` })
		.onConflictDoUpdate({
			target: [pieceImages.pieceName, pieceImages.version],
			set: {
				status: 'building',
				errorMessage: null,
				disabledAt: null,
				enabledAt: sql`now()`,
				updatedAt: sql`now()`
			}
		});
}

/** Upsert a `ready` row for an image that already exists in GHCR (enable shortcut). */
async function markReadyEnabled(
	pieceName: string,
	version: string,
	image: string,
	digest?: string
): Promise<void> {
	if (!db) return;
	await db
		.insert(pieceImages)
		.values({
			pieceName,
			version,
			image,
			digest: digest ?? null,
			status: 'ready',
			builtAt: sql`now()`,
			enabledAt: sql`now()`
		})
		.onConflictDoUpdate({
			target: [pieceImages.pieceName, pieceImages.version],
			set: {
				image,
				digest: digest ?? null,
				status: 'ready',
				errorMessage: null,
				disabledAt: null,
				builtAt: sql`now()`,
				enabledAt: sql`now()`,
				updatedAt: sql`now()`
			}
		});
}

/**
 * Build-completion callback (internal image-registration endpoint). Records the build
 * result WITHOUT touching enable-intent (enabledAt is preserved). Returns the row so
 * the caller can decide whether to flip `available_only` (only when an admin enabled it).
 */
export async function recordImageResult(
	pieceName: string,
	version: string,
	result: { status: PieceImageStatus; image?: string; digest?: string; errorMessage?: string }
): Promise<{ enabledAt: Date | null } | null> {
	if (!db) return null;
	const setReady = result.status === 'ready';
	await db
		.insert(pieceImages)
		.values({
			pieceName,
			version,
			status: result.status,
			image: result.image ?? null,
			digest: result.digest ?? null,
			errorMessage: result.errorMessage ?? null,
			builtAt: setReady ? sql`now()` : null
		})
		.onConflictDoUpdate({
			target: [pieceImages.pieceName, pieceImages.version],
			set: {
				status: result.status,
				image: result.image ?? null,
				digest: result.digest ?? null,
				errorMessage: result.errorMessage ?? null,
				...(setReady ? { builtAt: sql`now()`, disabledAt: null } : {}),
				updatedAt: sql`now()`
			}
			// enabledAt deliberately NOT in `set` — preserve the admin's enable intent.
		});
	const [row] = await db
		.select({ enabledAt: pieceImages.enabledAt })
		.from(pieceImages)
		.where(and(eq(pieceImages.pieceName, pieceName), eq(pieceImages.version, version)))
		.limit(1);
	return row ?? null;
}

/**
 * SPOKE-SIDE POLLING reconcile (docs/per-piece-runtime-images.md). The per-piece build
 * runs on the hub, but the cross-cluster register callback can't resolve a spoke's
 * Tailscale MagicDNS — so each spoke instead asks its OWN BFF to reconcile its `building`
 * rows against GHCR (in-cluster, no MagicDNS, no egress, no TLS to the spoke).
 *
 * For each `building` row: if the image now exists in GHCR, record it `ready` (preserving
 * enable intent) and — when the row was admin-enabled (enabledAt set) — flip it runnable so
 * the reconciler provisions it. If the image is still missing past `buildTimeoutMs` (since
 * the row's last update), record `failed`; otherwise leave it `building` (still in progress).
 */
export async function reconcileBuildingImages(opts?: {
	buildTimeoutMs?: number;
}): Promise<{ checked: number; readied: number; failed: number }> {
	const buildTimeoutMs =
		opts?.buildTimeoutMs ?? (parseInt(env.PIECE_BUILD_TIMEOUT_MS ?? '', 10) || 30 * 60 * 1000);
	if (!db) return { checked: 0, readied: 0, failed: 0 };

	const rows = await db
		.select({
			pieceName: pieceImages.pieceName,
			version: pieceImages.version,
			updatedAt: pieceImages.updatedAt,
			enabledAt: pieceImages.enabledAt
		})
		.from(pieceImages)
		.where(eq(pieceImages.status, 'building'));

	let checked = 0;
	let readied = 0;
	let failed = 0;
	for (const row of rows) {
		checked++;
		try {
			const { exists, digest } = await ghcrImageExists(row.pieceName, row.version);
			if (exists) {
				// Image landed — record ready (enabledAt preserved) and, when the row was
				// admin-enabled, flip it runnable so the reconciler provisions it.
				const result = await recordImageResult(row.pieceName, row.version, {
					status: 'ready',
					image: pieceImageRef(row.pieceName, row.version),
					digest
				});
				if (result?.enabledAt != null) {
					await markPieceRunnable(row.pieceName);
				}
				readied++;
			} else {
				// Still no image — fail only once the build has had its full timeout budget.
				const age = Date.now() - row.updatedAt.getTime();
				if (age > buildTimeoutMs) {
					await recordImageResult(row.pieceName, row.version, {
						status: 'failed',
						errorMessage: 'build did not produce a GHCR image within the timeout'
					});
					failed++;
				}
				// else: still in progress — leave it `building` (no-op this cycle).
			}
		} catch (err) {
			// One bad row must not abort the whole sweep — log and move on.
			console.warn(
				`[reconcileBuildingImages] ${row.pieceName}:${row.version} reconcile failed:`,
				err
			);
		}
	}
	return { checked, readied, failed };
}

/**
 * Enable a piece on THIS cluster. Resolves the catalog version, checks GHCR, and either
 * marks it ready+runnable instantly (image exists) or records `building` + triggers a
 * hub build (the registration callback later flips it runnable).
 */
export async function enablePiece(pieceName: string, opts: { callbackUrl: string }): Promise<EnableResult> {
	if (!db) throw new Error('Database not configured');
	if (!isValidPieceSlug(pieceName)) throw new Error(`invalid piece name: ${pieceName}`);

	const [meta] = await db
		.select({ version: pieceMetadata.version })
		.from(pieceMetadata)
		.where(and(eq(pieceMetadata.name, pieceName), eq(pieceMetadata.catalogSchemaVersion, 1)))
		.orderBy(desc(pieceMetadata.updatedAt))
		.limit(1);
	if (!meta?.version) throw new Error(`piece '${pieceName}' is not in the catalog`);
	const version = meta.version;

	const { exists, digest } = await ghcrImageExists(pieceName, version);
	if (exists) {
		const image = pieceImageRef(pieceName, version);
		await markReadyEnabled(pieceName, version, image, digest);
		await markPieceRunnable(pieceName);
		return { pieceName, version, status: 'ready', image, digest, madeRunnable: true };
	}

	await markBuilding(pieceName, version);
	const build = await triggerPieceImageBuild({ pieceName, pieceVersion: version, callbackUrl: opts.callbackUrl });
	return { pieceName, version, status: 'building', madeRunnable: false, build };
}

export interface PieceImageStatusInfo {
	status: PieceImageStatus;
	image: string | null;
	errorMessage: string | null;
	/** Admin-enabled (enabled_at set) — the reconciler only provisions enabled rows. */
	enabled: boolean;
}

/** Read current per-piece image status for a set of pieces (admin UI badges). */
export async function getPieceImageStatuses(
	pieceNames: string[]
): Promise<Map<string, PieceImageStatusInfo>> {
	const out = new Map<string, PieceImageStatusInfo>();
	if (!db || pieceNames.length === 0) return out;
	const rows = await db
		.select({
			pieceName: pieceImages.pieceName,
			status: pieceImages.status,
			image: pieceImages.image,
			errorMessage: pieceImages.errorMessage,
			enabledAt: pieceImages.enabledAt,
			disabledAt: pieceImages.disabledAt,
			updatedAt: pieceImages.updatedAt
		})
		.from(pieceImages)
		.where(inArray(pieceImages.pieceName, pieceNames))
		.orderBy(desc(pieceImages.updatedAt));
	// Keep the most-recently-updated row per piece (a piece may have multiple versions);
	// rows are pre-sorted newest-first, so the first row seen per piece wins.
	for (const r of rows) {
		if (out.has(r.pieceName)) continue;
		out.set(r.pieceName, {
			status: r.status as PieceImageStatus,
			image: r.image,
			errorMessage: r.errorMessage,
			enabled: r.enabledAt != null && r.disabledAt == null
		});
	}
	return out;
}
