import { and, asc, desc, gt, gte, sql as drizzleSql } from "drizzle-orm";

import type {
	GitOpsActivityEventListOptions,
	GitOpsActivityEventStore,
} from "$lib/server/application/gitops-activity-events";
import { db as defaultDb, sql as defaultSql } from "$lib/server/db";
import { gitopsActivityEvents } from "$lib/server/db/schema";
import {
	clampGitOpsActivityEventLimit,
	gitOpsActivityEventStorageValues,
	normalizeGitOpsActivityEvent,
	parseGitOpsActivitySinceDate,
	rowToEvent,
} from "$lib/server/gitops/activity-events";

type Database = typeof defaultDb;
type SqlClient = typeof defaultSql;

function requireDb(database: Database): Database {
	if (!database) throw new Error("Database not configured");
	return database;
}

export class PostgresGitOpsActivityEventStore
	implements GitOpsActivityEventStore
{
	constructor(
		private readonly database: Database = defaultDb,
		private readonly sqlClient: SqlClient = defaultSql,
	) {}

	async ingest(payload: unknown) {
		const database = requireDb(this.database);
		const event = normalizeGitOpsActivityEvent(payload);
		const values = gitOpsActivityEventStorageValues(event);
		const [row] = await database
			.insert(gitopsActivityEvents)
			.values(values)
			.onConflictDoUpdate({
				target: gitopsActivityEvents.eventId,
				set: {
					source: drizzleSql`excluded.source`,
					activityKey: drizzleSql`excluded.activity_key`,
					activityType: drizzleSql`excluded.activity_type`,
					phase: drizzleSql`excluded.phase`,
					reason: drizzleSql`excluded.reason`,
					message: drizzleSql`excluded.message`,
					resourceGroup: drizzleSql`excluded.resource_group`,
					resourceVersion: drizzleSql`excluded.resource_version`,
					resourceResource: drizzleSql`excluded.resource_resource`,
					resourceKind: drizzleSql`excluded.resource_kind`,
					resourceNamespace: drizzleSql`excluded.resource_namespace`,
					resourceName: drizzleSql`excluded.resource_name`,
					resourceUid: drizzleSql`excluded.resource_uid`,
					observedAt: drizzleSql`excluded.observed_at`,
					correlation: drizzleSql`excluded.correlation`,
					raw: drizzleSql`excluded.raw`,
					updatedAt: values.updatedAt,
				},
			})
			.returning();
		return rowToEvent(row);
	}

	async list(options: GitOpsActivityEventListOptions = {}) {
		const database = requireDb(this.database);
		const limit = clampGitOpsActivityEventLimit(options.limit);
		const conditions = [];
		if (Number.isFinite(options.afterSequence ?? NaN)) {
			conditions.push(
				gt(gitopsActivityEvents.sequence, Number(options.afterSequence)),
			);
		}
		const sinceDate = parseGitOpsActivitySinceDate(options.since);
		if (sinceDate) {
			conditions.push(gte(gitopsActivityEvents.observedAt, sinceDate));
		}
		const order = options.ascending
			? [asc(gitopsActivityEvents.sequence)]
			: [desc(gitopsActivityEvents.observedAt), desc(gitopsActivityEvents.sequence)];
		const rows = await database
			.select()
			.from(gitopsActivityEvents)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(...order)
			.limit(limit);
		return rows.map(rowToEvent);
	}

	async getLatestSequence(): Promise<number> {
		const database = requireDb(this.database);
		const [row] = await database
			.select({ sequence: gitopsActivityEvents.sequence })
			.from(gitopsActivityEvents)
			.orderBy(desc(gitopsActivityEvents.sequence))
			.limit(1);
		return row?.sequence ?? 0;
	}

	async subscribe(onEvent: () => void): Promise<() => Promise<void>> {
		if (!this.sqlClient) return async () => {};
		const listener = await this.sqlClient.listen("gitops_activity_events", onEvent);
		return () => listener.unlisten();
	}
}
