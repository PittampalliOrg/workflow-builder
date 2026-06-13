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
	if (!db) return { pieces: [], total: 0, enabledCount: 0 };
	const [pieces, disabled, wfRefs, mcpEnabled] = await Promise.all([
		db
			.select({
				name: pieceMetadata.name,
				displayName: pieceMetadata.displayName,
				logoUrl: pieceMetadata.logoUrl,
			})
			.from(pieceMetadata)
			// Only bundled/runnable pieces are disable-able here. Available-only rows
			// (the AP catalog not bundled in the image) are surfaced for discovery on
			// the connections page, not in this disable list — enabling one needs a
			// bundle + image rebuild, not a DB toggle. See docs/activepieces-catalog-expansion.md.
			.where(and(eq(pieceMetadata.catalogSchemaVersion, 1), eq(pieceMetadata.availableOnly, false))),
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
	const rows = pieces
		.filter((p): p is { name: string; displayName: string; logoUrl: string } => !!p.name)
		.map((p) => ({
			name: p.name,
			displayName: p.displayName ?? p.name,
			logoUrl: p.logoUrl,
			enabled: !disabledSet.has(p.name),
			inUse: inUse.has(p.name),
			pinned: PINNED.has(p.name),
		}))
		.sort((a, b) => a.displayName.localeCompare(b.displayName));
	return {
		pieces: rows,
		total: rows.length,
		enabledCount: rows.filter((r) => r.enabled).length,
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
};
