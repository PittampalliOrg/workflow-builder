import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

describe("Drasi Kubernetes observation projection migration", () => {
	it("backfills and maintains only current observer rows", async () => {
		const client = new PGlite();
		try {
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
				);
				insert into gitops_activity_events (
					event_id, source, activity_key, activity_type, phase,
					resource_group, resource_version, resource_resource,
					resource_kind, resource_namespace, resource_name,
					resource_uid, observed_at
				) values
					('current-1', 'drasi-kubernetes-observer-current', 'Component:workflow-builder/store', 'kubernetes.resource', 'Healthy', 'dapr.io', 'v1alpha1', 'components', 'Component', 'workflow-builder', 'store', 'uid-1', '2026-07-21T12:00:00Z'),
					('history-1', 'drasi-kubernetes-observer', 'Component:workflow-builder/store', 'kubernetes.resource', 'Healthy', 'dapr.io', 'v1alpha1', 'components', 'Component', 'workflow-builder', 'store', 'uid-1', '2026-07-21T12:00:00Z');
			`);
			await client.exec(
				readFileSync(
					resolve(
						process.cwd(),
						"drizzle/0110_drasi_kubernetes_observations.sql",
					),
					"utf8",
				),
			);
			await client.exec(
				readFileSync(
					resolve(
						process.cwd(),
						"drizzle/0111_drasi_kubernetes_observation_tombstones.sql",
					),
					"utf8",
				),
			);

			await expect(
				client.query<{ event_id: string; phase: string }>(
					"select event_id, phase from drasi_kubernetes_observations",
				),
			).resolves.toMatchObject({
				rows: [{ event_id: "current-1", phase: "Healthy" }],
			});

			await client.exec(`
				update gitops_activity_events
				set phase = 'Drifted', observed_at = '2026-07-21T12:05:00Z'
				where event_id = 'current-1';
				update gitops_activity_events
				set phase = 'Pending', observed_at = '2026-07-21T11:55:00Z'
				where event_id = 'current-1';
				insert into gitops_activity_events (
					event_id, source, activity_key, activity_type, phase, observed_at
				) values (
					'history-2', 'drasi-kubernetes-observer', 'Pod:workflow-builder/app',
					'kubernetes.resource', 'Warning', '2026-07-21T12:06:00Z'
				);
			`);

			const retained = await client.query<{
				phase: string;
				observed_at: string;
			}>(
				"select phase, observed_at::text as observed_at " +
					"from drasi_kubernetes_observations where event_id = 'current-1'",
			);
			expect(retained.rows[0]).toMatchObject({ phase: "Drifted" });
			expect(retained.rows[0].observed_at).toBe("2026-07-21 12:05:00");
			await expect(
				client.query<{ count: number }>(
					"select count(*)::int as count from drasi_kubernetes_observations",
				),
			).resolves.toMatchObject({ rows: [{ count: 1 }] });

			await client.exec(`
				update gitops_activity_events
				set phase = 'Deleted', observed_at = '2026-07-21T12:10:00Z'
				where event_id = 'current-1'
			`);
			await expect(
				client.query<{ count: number }>(
					"select count(*)::int as count from drasi_kubernetes_observations",
				),
			).resolves.toMatchObject({ rows: [{ count: 0 }] });

			await client.exec(`
				update gitops_activity_events
				set phase = 'Healthy', observed_at = '2026-07-21T12:11:00Z'
				where event_id = 'current-1'
			`);
			await expect(
				client.query<{ count: number }>(
					"select count(*)::int as count from drasi_kubernetes_observations",
				),
			).resolves.toMatchObject({ rows: [{ count: 1 }] });

			await client.exec(
				"delete from gitops_activity_events where event_id = 'current-1'",
			);
			await expect(
				client.query<{ count: number }>(
					"select count(*)::int as count from drasi_kubernetes_observations",
				),
			).resolves.toMatchObject({ rows: [{ count: 0 }] });
		} finally {
			await client.close();
		}
	});
});
