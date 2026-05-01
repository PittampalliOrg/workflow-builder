import { error, json } from "@sveltejs/kit";
import { and, desc, eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import {
	agents,
	agentVersions,
	resourcePromptVersions,
	resourcePrompts,
} from "$lib/server/db/schema";
import type { PromptPresetRef } from "$lib/types/agents";

type AgentUsage = {
	id: string;
	slug: string;
	name: string;
	bindingKind: "static" | "dynamic";
	version: number;
	latestVersion: number;
	isStale: boolean;
};

/**
 * Reverse-lookup: which agents bind a given preset (and at what version).
 * Used by the project Prompts editor to show "Used by N agents" with stale
 * indicators when bindings are pinned to an older version. Project-scoped:
 * the preset must belong to the caller's workspace, and only agents in the
 * same workspace are scanned.
 *
 * The N-agents-per-workspace count is bounded (typically <100), so the
 * straightforward "load configs in memory and filter" beats a JSONB
 * containment query on first reach. Replace with `config @>` containment if
 * the agent count grows past ~1000 per workspace.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(400, "No active workspace");
	if (!db) return error(503, "Database not configured");

	const presetId = params.id;
	if (!presetId) return error(400, "preset id is required");

	// 1. Resolve preset → confirm it lives in the caller's workspace + grab latest version
	const [preset] = await db
		.select({
			id: resourcePrompts.id,
			version: resourcePrompts.version,
		})
		.from(resourcePrompts)
		.where(
			and(
				eq(resourcePrompts.id, presetId),
				eq(resourcePrompts.projectId, locals.session.projectId),
			),
		)
		.limit(1);
	if (!preset) return error(404, "Preset not found in this workspace");

	const [latest] = await db
		.select({ version: resourcePromptVersions.version })
		.from(resourcePromptVersions)
		.where(eq(resourcePromptVersions.promptId, presetId))
		.orderBy(desc(resourcePromptVersions.version))
		.limit(1);
	const latestVersion = latest?.version ?? preset.version;

	// 2. Load agents + their current configs from this workspace
	const rows = await db
		.select({
			id: agents.id,
			slug: agents.slug,
			name: agents.name,
			isArchived: agents.isArchived,
			config: agentVersions.config,
		})
		.from(agents)
		.leftJoin(agentVersions, eq(agentVersions.id, agents.currentVersionId))
		.where(
			and(
				eq(agents.projectId, locals.session.projectId),
				eq(agents.isArchived, false),
			),
		);

	// 3. Filter for refs to this preset
	const usages: AgentUsage[] = [];
	for (const row of rows) {
		if (!row.config) continue;
		const cfg = row.config as Record<string, unknown>;
		const staticRefs = Array.isArray(cfg.staticPromptPresetRefs)
			? (cfg.staticPromptPresetRefs as PromptPresetRef[])
			: [];
		const dynamicRefs = Array.isArray(cfg.dynamicPromptPresetRefs)
			? (cfg.dynamicPromptPresetRefs as PromptPresetRef[])
			: [];
		for (const ref of staticRefs) {
			if (ref?.id === presetId) {
				usages.push({
					id: row.id,
					slug: row.slug,
					name: row.name,
					bindingKind: "static",
					version: ref.version,
					latestVersion,
					isStale: ref.version < latestVersion,
				});
			}
		}
		for (const ref of dynamicRefs) {
			if (ref?.id === presetId) {
				usages.push({
					id: row.id,
					slug: row.slug,
					name: row.name,
					bindingKind: "dynamic",
					version: ref.version,
					latestVersion,
					isStale: ref.version < latestVersion,
				});
			}
		}
	}

	// Stable sort: stale-first (so the editor surfaces what needs attention),
	// then alphabetical by name.
	usages.sort((a, b) => {
		if (a.isStale !== b.isStale) return a.isStale ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	return json({ usages, latestVersion });
};
