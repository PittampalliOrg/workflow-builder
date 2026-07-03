import { asc, eq } from "drizzle-orm";

import type { AgentProfileReadPort } from "$lib/server/application/agent-profiles";
import { db as defaultDb } from "$lib/server/db";
import {
	agentExecutionFacetVersions,
	agentModelFacetVersions,
	agentProfileTemplateVersions,
	agentProfileTemplates,
	agentToolPolicyFacetVersions,
} from "$lib/server/db/schema";
import {
	normalizeAgentProfileConfig,
	type AgentProfileSummary,
} from "$lib/server/agent-profiles";

type Database = typeof defaultDb;

export class PostgresAgentProfileReadRepository implements AgentProfileReadPort {
	constructor(private readonly database: Database = defaultDb) {}

	async listDatabaseAgentProfiles(): Promise<AgentProfileSummary[]> {
		if (!this.database) return [];

		const rows = await this.database
			.select({
				templateId: agentProfileTemplates.id,
				slug: agentProfileTemplates.slug,
				name: agentProfileTemplates.name,
				description: agentProfileTemplates.description,
				category: agentProfileTemplates.category,
				version: agentProfileTemplateVersions.version,
				isDefaultVersion: agentProfileTemplateVersions.isDefault,
				toolPolicy: agentToolPolicyFacetVersions.config,
				model: agentModelFacetVersions.config,
				execution: agentExecutionFacetVersions.config,
			})
			.from(agentProfileTemplates)
			.leftJoin(
				agentProfileTemplateVersions,
				eq(agentProfileTemplateVersions.templateId, agentProfileTemplates.id),
			)
			.leftJoin(
				agentToolPolicyFacetVersions,
				eq(
					agentToolPolicyFacetVersions.id,
					agentProfileTemplateVersions.toolPolicyFacetVersionId,
				),
			)
			.leftJoin(
				agentModelFacetVersions,
				eq(agentModelFacetVersions.id, agentProfileTemplateVersions.modelFacetVersionId),
			)
			.leftJoin(
				agentExecutionFacetVersions,
				eq(agentExecutionFacetVersions.id, agentProfileTemplateVersions.executionFacetVersionId),
			)
			.where(eq(agentProfileTemplates.isEnabled, true))
			.orderBy(asc(agentProfileTemplates.sortOrder), asc(agentProfileTemplates.name));

		const byTemplate = new Map<string, (typeof rows)[number]>();
		for (const row of rows) {
			const existing = byTemplate.get(row.templateId);
			if (
				!existing ||
				row.isDefaultVersion ||
				(!existing.isDefaultVersion && (row.version ?? 0) > (existing.version ?? 0))
			) {
				byTemplate.set(row.templateId, row);
			}
		}

		return [...byTemplate.values()].map((row) => ({
			id: row.templateId,
			templateId: row.templateId,
			slug: row.slug,
			name: row.name,
			description: row.description,
			category: row.category,
			version: row.version ?? 1,
			source: "database" as const,
			config: normalizeAgentProfileConfig({
				toolPolicy: row.toolPolicy,
				model: row.model,
				execution: row.execution,
			}),
		}));
	}
}
