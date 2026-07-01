import type {
	AppendSessionEventInput,
	SessionEventLog,
	SessionRepository,
} from "$lib/server/application/ports";
import { appendEvent } from "$lib/server/sessions/events";
import { getSession } from "$lib/server/sessions/registry";
import type { SessionDetail, SessionEventEnvelope } from "$lib/types/sessions";

export class CurrentSessionRepository implements SessionRepository {
	getSession(id: string): Promise<SessionDetail | null> {
		return getSession(id);
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
