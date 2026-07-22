import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createPgliteDb } from "$lib/server/db/pglite-compat";
import { PostgresSessionEventLog } from "$lib/server/application/adapters/session-events";
import { PostgresTeamStore } from "$lib/server/application/adapters/team-store";
import { ApplicationTeamMailboxDeliveryService } from "$lib/server/application/team-mailbox-delivery";
import type {
	EventBus,
	TeamRuntimeHostPort,
} from "$lib/server/application/ports";
import { deliverTeamMessages, teamMailboxBatchId } from "$lib/server/teams/team-delivery";
import { db as defaultDb } from "$lib/server/db";

type Db = typeof defaultDb;

async function freshDb(): Promise<Db> {
	const { db } = createPgliteDb();
	await db.execute(sql.raw(`
		CREATE TABLE sessions (
			id text PRIMARY KEY,
			status text NOT NULL DEFAULT 'idle',
			stop_requested_at timestamp,
			dapr_instance_id text,
			runtime_app_id text,
			runtime_sandbox_name text
		);
		CREATE TABLE team_members (
			id text PRIMARY KEY,
			team_id text NOT NULL,
			session_id text UNIQUE NOT NULL,
			name text NOT NULL,
			role text NOT NULL DEFAULT 'member',
			status text NOT NULL DEFAULT 'working',
			updated_at timestamp NOT NULL DEFAULT now(),
			runtime_operation_id text,
			runtime_operation text,
			runtime_operation_started_at timestamp,
			runtime_desired_running boolean NOT NULL DEFAULT true
		);
		CREATE TABLE session_events (
			id text PRIMARY KEY,
			session_id text NOT NULL,
			sequence integer NOT NULL,
			type text NOT NULL,
			data jsonb NOT NULL DEFAULT '{}'::jsonb,
			processed_at timestamp,
			team_delivery_claim_token text,
			team_delivery_claimed_at timestamp,
			source_event_id text,
			producer_id text,
			producer_epoch text,
			created_at timestamp NOT NULL DEFAULT now()
		)
	`));
	return db as unknown as Db;
}

function readyRuntimeHost(): TeamRuntimeHostPort {
	return {
		getPodStatus: vi.fn(async () => ({
			presence: "present" as const,
			exited: false,
		})),
		deleteExitedPods: vi.fn(async () => []),
		getSandboxState: vi.fn(async () => ({
			presence: "present" as const,
			desiredRunning: true,
		})),
		resume: vi.fn(async () => "patched" as const),
		suspend: vi.fn(async () => "patched" as const),
		waitUntilReady: vi.fn(async () => {}),
	};
}

describe.each(["dapr-agent-py", "pydantic-ai-agent-py"])(
	"pre-runtime team mailbox through %s",
	(runtimeAppId) => {
		it("uses one stable receipted turn, completes the row, and leaves no sweep candidate", async () => {
			const db = await freshDb();
			const eventLog = new PostgresSessionEventLog(db);
			const store = new PostgresTeamStore(() => db);
			const eventBus: EventBus = { publish: vi.fn(async () => {}) };
			const mailbox = new ApplicationTeamMailboxDeliveryService({
				sessionEvents: eventLog,
				eventBus,
			});
			const prompt = {
				type: "user.message",
				content: [{ type: "text", text: "initial prompt" }],
			};
			const teamMessage = {
				type: "user.message",
				origin: "teammate-message",
				fromAgent: "lead",
				content: [{ type: "text", text: "review this" }],
			};

			await db.execute(sql`
				INSERT INTO sessions (id, status)
				VALUES ('session-1', 'rescheduling')
			`);
			await db.execute(sql`
				INSERT INTO team_members (id, team_id, session_id, name, role, status)
				VALUES ('member-1', 'team-1', 'session-1', 'worker', 'member', 'working')
			`);
			await db.execute(sql`
				INSERT INTO session_events (id, session_id, sequence, type, data, processed_at, created_at)
				VALUES
					('prompt-event', 'session-1', 1, 'user.message', ${JSON.stringify(prompt)}::jsonb, NULL, now() - interval '5 minutes'),
					('team-event', 'session-1', 2, 'user.message', ${JSON.stringify(teamMessage)}::jsonb, NULL, now() - interval '5 minutes')
			`);

			expect(
				mailbox.initialUserEvents([
					{ type: "user.message", data: prompt },
					{ type: "user.message", data: teamMessage },
				]),
			).toEqual([prompt]);

			await db.execute(sql`
				UPDATE sessions
				SET status = 'idle', dapr_instance_id = 'workflow-1',
					runtime_app_id = ${runtimeAppId}
				WHERE id = 'session-1'
			`);
			const strandedBeforeDelivery =
				await store.listSessionsWithStrandedTeamMessages({
					olderThanSeconds: 0,
				});
			expect(strandedBeforeDelivery.map((row) => row.session_id)).toEqual([
				"session-1",
			]);
			expect(Number(strandedBeforeDelivery[0]?.stranded)).toBe(1);
			await expect(
				mailbox.requestDeliveryAfterRuntimePublished("session-1"),
			).resolves.toBe("published");
			expect(eventBus.publish).toHaveBeenCalledOnce();

			const acceptedEventIds = new Set<string>();
			const acceptedBatchIds = new Set<string>();
			let modelTurns = 0;
			const raiseSessionUserEvents = vi.fn(
				async (
					_sessionId: string,
					events: Array<Record<string, unknown>>,
					delivery: {
						kind: "team-mailbox";
						batchId: string;
						eventIds: string[];
					},
				) => {
					expect(delivery).toEqual({
						kind: "team-mailbox",
						batchId: teamMailboxBatchId("session-1", ["team-event"]),
						eventIds: ["team-event"],
					});
					const newEvents = delivery.eventIds.filter(
						(eventId) => !acceptedEventIds.has(eventId),
					);
					if (
						!acceptedBatchIds.has(delivery.batchId) &&
						newEvents.length > 0
					) {
						modelTurns += 1;
					}
					acceptedBatchIds.add(delivery.batchId);
					newEvents.forEach((eventId) => acceptedEventIds.add(eventId));
					expect(events).toEqual([teamMessage]);
					return { accepted: true as const, deliveryId: delivery.batchId };
				},
			);

			const deps = {
				store,
				runtimeHost: readyRuntimeHost(),
				claimUnraisedTeamEvents: (input: {
					sessionId: string;
					claimToken: string;
					staleAfterSeconds: number;
				}) => eventLog.claimUnraisedTeamEvents(input),
				hasUnprocessedTeamEvents: (sessionId: string) =>
					eventLog.hasUnprocessedTeamEvents(sessionId),
				completeTeamEventDelivery: (input: {
					sessionId: string;
					claimToken: string;
				}) => eventLog.completeTeamEventDelivery(input),
				releaseTeamEventDeliveryClaim: (input: {
					sessionId: string;
					claimToken: string;
				}) => eventLog.releaseTeamEventDeliveryClaim(input),
				newClaimToken: () => `${runtimeAppId}-claim`,
				ensurePublishedRuntimeHost: vi.fn(async () => ({ recovered: false })),
				raiseSessionUserEvents,
				appendSessionEvent: vi.fn(async () => ({})),
			};

			await expect(deliverTeamMessages("session-1", deps)).resolves.toBe(
				"delivered",
			);
			await expect(deliverTeamMessages("session-1", deps)).resolves.toBe(
				"delivered",
			);
			expect(modelTurns).toBe(1);
			expect(raiseSessionUserEvents).toHaveBeenCalledOnce();
			expect(acceptedEventIds).toEqual(new Set(["team-event"]));

			const rows = (await db.execute(sql`
				SELECT processed_at, team_delivery_claim_token
				FROM session_events
				WHERE id = 'team-event'
			`)) as Array<{
				processed_at: Date | null;
				team_delivery_claim_token: string | null;
			}>;
			expect(rows[0]?.processed_at).not.toBeNull();
			expect(rows[0]?.team_delivery_claim_token).toBeNull();
			expect(
				await store.listSessionsWithStrandedTeamMessages({
					olderThanSeconds: 0,
				}),
			).toHaveLength(0);
			await expect(
				mailbox.requestDeliveryAfterRuntimePublished("session-1"),
			).resolves.toBe("empty");
			expect(eventBus.publish).toHaveBeenCalledOnce();
		});
	},
);
