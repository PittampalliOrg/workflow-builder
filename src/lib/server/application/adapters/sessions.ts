import type {
	AppendSessionEventInput,
	SessionEventLog,
	SessionRepository,
} from "$lib/server/application/ports";
import { eq, or } from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import { sessions } from "$lib/server/db/schema";
import { appendEvent } from "$lib/server/sessions/events";
import { getSession } from "$lib/server/sessions/registry";
import type { SessionDetail, SessionEventEnvelope } from "$lib/types/sessions";

type Database = typeof defaultDb;

function requireDb(database: Database = defaultDb): Database {
	if (!database) throw new Error("Database not configured");
	return database;
}

export class CurrentSessionRepository implements SessionRepository {
	constructor(private readonly database?: Database) {}

	getSession(id: string): Promise<SessionDetail | null> {
		return getSession(id);
	}

	async findSessionIdByDaprInstanceId(instanceId: string): Promise<string | null> {
		const value = instanceId.trim();
		if (!value) return null;
		const database = requireDb(this.database);
		const [row] = await database
			.select({ id: sessions.id })
			.from(sessions)
			.where(eq(sessions.daprInstanceId, value))
			.limit(1);
		return row?.id ?? null;
	}

	async resolveSessionIdForProvisioningEvent(input: {
		runtimeAppId?: string | null;
		sessionId?: string | null;
	}): Promise<string | null> {
		const runtimeAppId = input.runtimeAppId?.trim() ?? "";
		const sessionId = input.sessionId?.trim() ?? "";
		const matchers = [];
		if (runtimeAppId) matchers.push(eq(sessions.runtimeAppId, runtimeAppId));
		if (sessionId) {
			matchers.push(eq(sessions.id, sessionId), eq(sessions.daprInstanceId, sessionId));
		}
		if (matchers.length === 0) return null;
		const database = requireDb(this.database);
		const [row] = await database
			.select({ id: sessions.id })
			.from(sessions)
			.where(or(...matchers))
			.limit(1);
		return row?.id ?? null;
	}

	async getSessionFileOwner(
		sessionId: string,
	): Promise<{ id: string; userId: string; projectId: string | null } | null> {
		const database = requireDb(this.database);
		const [row] = await database
			.select({
				id: sessions.id,
				userId: sessions.userId,
				projectId: sessions.projectId,
			})
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1);
		return row ?? null;
	}
}

export class PostgresSessionEventLog implements SessionEventLog {
	appendSessionEvent(
		sessionId: string,
		event: AppendSessionEventInput,
	): Promise<SessionEventEnvelope> {
		return appendEvent(sessionId, event);
	}
}
