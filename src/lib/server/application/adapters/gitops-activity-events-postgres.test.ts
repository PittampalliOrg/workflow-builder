import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { PostgresGitOpsActivityEventStore } from "./gitops-activity-events";

describe("PostgresGitOpsActivityEventStore current snapshots", () => {
	let client: PGlite;
	let store: PostgresGitOpsActivityEventStore;

	beforeEach(async () => {
		client = new PGlite();
		await client.exec(`
			create table gitops_activity_events (
				event_id text primary key,
				sequence serial not null unique,
				source text not null,
				activity_key text not null,
				activity_type text not null,
				phase text,
				reason text,
				message text,
				resource_group text,
				resource_version text,
				resource_resource text,
				resource_kind text,
				resource_namespace text,
				resource_name text,
				resource_uid text,
				observed_at timestamp not null,
				correlation jsonb not null default '{}'::jsonb,
				raw jsonb not null default '{}'::jsonb,
				created_at timestamp not null default now(),
				updated_at timestamp not null default now()
			)
		`);
		store = new PostgresGitOpsActivityEventStore(
			drizzle(client) as never,
			null as never,
		);
	});

	afterEach(async () => {
		await client.close();
	});

	it("does not let a delayed observation regress a newer current row", async () => {
		const base = {
			eventId: "drasi-k8s-current:resource-1",
			source: "drasi-kubernetes-observer-current",
			activityKey: "Component:workflow-builder/workflowstatestore",
			activityType: "kubernetes.resource",
			resourceRef: {
				group: "dapr.io",
				version: "v1alpha1",
				resource: "components",
				kind: "Component",
				namespace: "workflow-builder",
				name: "workflowstatestore",
				uid: "uid-1",
			},
			correlation: { cluster: "dev" },
			raw: {},
		};

		await store.ingest({
			...base,
			phase: "Healthy",
			observedAt: "2026-07-21T12:05:00Z",
		});
		const retained = await store.ingest({
			...base,
			phase: "Drifted",
			observedAt: "2026-07-21T12:00:00Z",
		});
		expect(retained).toMatchObject({
			phase: "Healthy",
			observedAt: "2026-07-21T12:05:00.000Z",
		});

		const result = await client.query<{
			phase: string;
		}>("select phase, observed_at from gitops_activity_events where event_id = $1", [
			base.eventId,
		]);
		expect(result.rows[0]).toMatchObject({ phase: "Healthy" });
	});
});
