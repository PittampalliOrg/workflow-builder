import type { PageServerLoad, Actions } from "./$types";
import { db } from "$lib/server/db";
import {
	pieceMetadata,
	platformDisabledPieces,
	workflowConnectionRefs,
	mcpConnections,
	users,
} from "$lib/server/db/schema";
import { and, eq } from "drizzle-orm";
import { error, fail } from "@sveltejs/kit";
import { getAppUrl } from "$lib/server/app-url";
import {
	enablePiece,
	getPieceImageStatuses,
	isValidPieceSlug,
} from "$lib/server/pieces/piece-images";

// Mirrors PINNED_PIECES in the activepieces-mcp reconciler — always-on regardless
// of the disable list (shown so an admin knows disabling won't reap them).
const PINNED = new Set(["github", "google-calendar", "openai"]);

/**
 * Re-check platform admin INSIDE the action. The (admin) layout guard only runs
 * on page loads, not on POSTed form actions, so a direct POST would otherwise
 * bypass it.
 */
async function requireAdmin(userId: string | undefined | null): Promise<void> {
	if (!db || !userId) throw error(403, "Admin access required");
	const [row] = await db
		.select({ role: users.platformRole })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (row?.role !== "ADMIN") throw error(403, "Admin access required");
}

export const load: PageServerLoad = async () => {
	if (!db)
		return { pieces: [], available: [], total: 0, enabledCount: 0, availableCount: 0 };
	const [bundled, availableRows, disabled, wfRefs, mcpEnabled] = await Promise.all([
		db
			.select({
				name: pieceMetadata.name,
				displayName: pieceMetadata.displayName,
				logoUrl: pieceMetadata.logoUrl,
			})
			.from(pieceMetadata)
			// Bundled/runnable pieces (in the shared image OR with a ready per-piece image).
			.where(and(eq(pieceMetadata.catalogSchemaVersion, 1), eq(pieceMetadata.availableOnly, false))),
		db
			.select({
				name: pieceMetadata.name,
				displayName: pieceMetadata.displayName,
				logoUrl: pieceMetadata.logoUrl,
			})
			.from(pieceMetadata)
			// Available-only catalog pieces (NOT yet provisioned). With per-piece runtime
			// images these are now enable-able here: enabling builds/pins a dedicated
			// ap-piece-<name> image (docs/per-piece-runtime-images.md) — no bundle rebuild.
			.where(and(eq(pieceMetadata.catalogSchemaVersion, 1), eq(pieceMetadata.availableOnly, true))),
		db.select({ pieceName: platformDisabledPieces.pieceName }).from(platformDisabledPieces),
		db.selectDistinct({ pieceName: workflowConnectionRefs.pieceName }).from(workflowConnectionRefs),
		db
			.selectDistinct({ pieceName: mcpConnections.pieceName })
			.from(mcpConnections)
			.where(and(eq(mcpConnections.sourceType, "nimble_piece"), eq(mcpConnections.status, "ENABLED"))),
	]);

	const disabledSet = new Set(disabled.map((d) => d.pieceName));
	const inUse = new Set<string>();
	for (const r of wfRefs) if (r.pieceName) inUse.add(r.pieceName);
	for (const r of mcpEnabled) if (r.pieceName) inUse.add(r.pieceName);

	const bundledNames = bundled.map((p) => p.name).filter((n): n is string => !!n);
	const availableNames = availableRows.map((p) => p.name).filter((n): n is string => !!n);
	const imageStatuses = await getPieceImageStatuses([...bundledNames, ...availableNames]);

	// A piece is enabled-via-per-piece-image when it has a ready+enabled image row. Such
	// a piece stays available_only=true (metadata-sync owns that as bundle membership),
	// but it IS provisioned — so reclassify it into the "provisioned" list, not "available".
	const enabledByImage = (name: string) => {
		const img = imageStatuses.get(name);
		return img?.status === "ready" && img.enabled === true;
	};

	const bundledPieces = bundled
		.filter((p): p is { name: string; displayName: string; logoUrl: string } => !!p.name)
		.map((p) => ({
			name: p.name,
			displayName: p.displayName ?? p.name,
			logoUrl: p.logoUrl,
			enabled: !disabledSet.has(p.name),
			inUse: inUse.has(p.name),
			pinned: PINNED.has(p.name),
			perPiece: imageStatuses.get(p.name)?.status === "ready",
		}));

	// Available-only pieces that have been enabled onto their own per-piece image.
	const perPieceEnabled = availableRows
		.filter((p): p is { name: string; displayName: string; logoUrl: string } => !!p.name && enabledByImage(p.name))
		.map((p) => ({
			name: p.name,
			displayName: p.displayName ?? p.name,
			logoUrl: p.logoUrl,
			enabled: !disabledSet.has(p.name),
			inUse: inUse.has(p.name),
			pinned: PINNED.has(p.name),
			perPiece: true,
		}));

	const pieces = [...bundledPieces, ...perPieceEnabled].sort((a, b) =>
		a.displayName.localeCompare(b.displayName),
	);

	const available = availableRows
		.filter((p): p is { name: string; displayName: string; logoUrl: string } => !!p.name && !enabledByImage(p.name))
		.map((p) => {
			const img = imageStatuses.get(p.name);
			return {
				name: p.name,
				displayName: p.displayName ?? p.name,
				logoUrl: p.logoUrl,
				// build lifecycle: null (never built) | building | ready | failed
				buildStatus: img?.status ?? null,
				errorMessage: img?.errorMessage ?? null,
			};
		})
		.sort((a, b) => a.displayName.localeCompare(b.displayName));

	return {
		pieces,
		available,
		total: pieces.length,
		enabledCount: pieces.filter((r) => r.enabled).length,
		availableCount: available.length,
	};
};

export const actions: Actions = {
	toggle: async ({ request, locals }) => {
		await requireAdmin(locals.session?.userId);
		const form = await request.formData();
		const pieceName = String(form.get("pieceName") ?? "").trim();
		const enable = String(form.get("enable")) === "true";
		if (!pieceName) return fail(400, { error: "pieceName required" });
		if (!db) return fail(503, { error: "Database not configured" });
		if (enable) {
			// Re-enable: remove from the disable list.
			await db.delete(platformDisabledPieces).where(eq(platformDisabledPieces.pieceName, pieceName));
		} else {
			// Disable: add to the blocklist (the reconciler skips its `catalog`
			// provisioning; pinned/workflow-referenced/mcp-enabled keep used pieces).
			await db
				.insert(platformDisabledPieces)
				.values({
					pieceName,
					disabledBy: locals.session?.userId ?? null,
					platformId: "default-platform",
				})
				.onConflictDoNothing();
		}
		return { success: true, pieceName, enabled: enable };
	},

	// Enable an available-only catalog piece via its per-piece runtime image. Instant
	// when the GHCR image already exists; otherwise records `building` + triggers a
	// hub build (docs/per-piece-runtime-images.md).
	enable: async ({ request, locals, url }) => {
		await requireAdmin(locals.session?.userId);
		const form = await request.formData();
		const pieceName = String(form.get("pieceName") ?? "").trim();
		if (!pieceName || !isValidPieceSlug(pieceName)) return fail(400, { error: "valid pieceName required" });
		if (!db) return fail(503, { error: "Database not configured" });
		try {
			const callbackUrl = await getAppUrl(url, request);
			const result = await enablePiece(pieceName, { callbackUrl });
			return { success: true, ...result };
		} catch (err) {
			const msg = err instanceof Error ? err.message : "enable failed";
			return fail(/not in the catalog/.test(msg) ? 404 : 500, { error: msg, pieceName });
		}
	},
};
