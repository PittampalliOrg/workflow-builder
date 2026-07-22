import type {
	EventBus,
	SessionEventLog,
} from "$lib/server/application/ports";
import type { SessionEventEnvelope } from "$lib/types/sessions";

export const TEAM_MAILBOX_DELIVERY_TOPIC = "workflow.team-message";

export const TEAM_MAILBOX_EVENT_ORIGINS = [
	"teammate-message",
	"team-broadcast",
	"team-idle",
	"team-error",
] as const;

const TEAM_MAILBOX_EVENT_ORIGIN_SET = new Set<string>(
	TEAM_MAILBOX_EVENT_ORIGINS,
);

export function isTeamMailboxSessionEvent(
	event: Pick<SessionEventEnvelope, "type" | "data">,
): boolean {
	return (
		event.type === "user.message" &&
		TEAM_MAILBOX_EVENT_ORIGIN_SET.has(String(event.data.origin ?? ""))
	);
}

export class ApplicationTeamMailboxDeliveryService {
	constructor(
		private readonly deps: {
			sessionEvents: Pick<SessionEventLog, "hasUnprocessedTeamEvents">;
			eventBus: EventBus;
		},
	) {}

	/**
	 * Bootstrap only ordinary user input. Team-origin rows stay in the durable
	 * mailbox so their stable database ids reach the runtime receipt protocol.
	 */
	initialUserEvents(
		events: Array<Pick<SessionEventEnvelope, "type" | "data">>,
	): Array<Record<string, unknown>> {
		return events
			.filter(
				(event) =>
					event.type.startsWith("user.") &&
					!isTeamMailboxSessionEvent(event),
			)
			.map((event) => event.data);
	}

	/**
	 * Close the create-to-runtime-publication race. The mailbox row is the
	 * durable source of truth; this notification only prompts the existing
	 * claim/receipt worker to drain it immediately.
	 */
	async requestDeliveryAfterRuntimePublished(
		sessionId: string,
	): Promise<"empty" | "published"> {
		if (!(await this.deps.sessionEvents.hasUnprocessedTeamEvents(sessionId))) {
			return "empty";
		}
		await this.deps.eventBus.publish(TEAM_MAILBOX_DELIVERY_TOPIC, {
			recipientSessionId: sessionId,
			reason: "runtime-published",
		});
		return "published";
	}
}
