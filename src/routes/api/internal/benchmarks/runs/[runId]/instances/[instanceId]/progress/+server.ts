import { and, desc, eq } from "drizzle-orm";
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { benchmarkRunInstances, sessionEvents } from "$lib/server/db/schema";
import { requireDb } from "$lib/server/db";
import { requireInternal } from "$lib/server/internal-auth";

export const GET: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const database = requireDb();
	const [instance] = await database
		.select({
			id: benchmarkRunInstances.id,
			status: benchmarkRunInstances.status,
			inferenceStatus: benchmarkRunInstances.inferenceStatus,
			evaluationStatus: benchmarkRunInstances.evaluationStatus,
			sessionId: benchmarkRunInstances.sessionId,
			updatedAt: benchmarkRunInstances.updatedAt,
		})
		.from(benchmarkRunInstances)
		.where(
			and(
				eq(benchmarkRunInstances.runId, params.runId),
				eq(benchmarkRunInstances.instanceId, params.instanceId),
			),
		)
		.limit(1);
	if (!instance) return error(404, "Benchmark instance not found");

	const [latestEvent] = instance.sessionId
		? await database
				.select({
					sequence: sessionEvents.sequence,
					type: sessionEvents.type,
					createdAt: sessionEvents.createdAt,
				})
				.from(sessionEvents)
				.where(eq(sessionEvents.sessionId, instance.sessionId))
				.orderBy(desc(sessionEvents.sequence))
				.limit(1)
		: [];
	const latestActivityAt = latestEvent?.createdAt ?? instance.updatedAt;
	const activityAgeSeconds = Math.max(
		0,
		Math.floor((Date.now() - latestActivityAt.getTime()) / 1000),
	);
	return json({
		status: instance.status,
		inferenceStatus: instance.inferenceStatus,
		evaluationStatus: instance.evaluationStatus,
		sessionId: instance.sessionId,
		latestSessionEventType: latestEvent?.type ?? null,
		latestSessionEventSequence: latestEvent?.sequence ?? null,
		latestActivityAt: latestActivityAt.toISOString(),
		activityAgeSeconds,
		progressMarker: [
			instance.status,
			instance.inferenceStatus,
			instance.evaluationStatus,
			instance.updatedAt.toISOString(),
			latestEvent?.sequence ?? "no-session-event",
			latestEvent?.createdAt.toISOString() ?? "no-session-event",
		].join(":"),
	});
};
