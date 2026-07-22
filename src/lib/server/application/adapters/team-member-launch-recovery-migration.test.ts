import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const migrationPaths = [
  "drizzle/0117_team_member_launch_recovery.sql",
  "atlas/migrations/20260721183000_team_member_launch_recovery.sql",
];

describe.each(migrationPaths)(
  "team launch recovery migration %s",
  (migrationPath) => {
    let client: PGlite | null = null;

    afterEach(async () => {
      await client?.close();
      client = null;
    });

    async function migratedClient(): Promise<PGlite> {
      const database = new PGlite();
      await database.exec(`
      CREATE TABLE team_members (
        id text PRIMARY KEY,
        status text NOT NULL DEFAULT 'working'
      );
    `);
      await database.exec(
        readFileSync(resolve(process.cwd(), migrationPath), "utf8"),
      );
      client = database;
      return database;
    }

    it("accepts complete spawn and revival metadata", async () => {
      const database = await migratedClient();
      await expect(
        database.exec(`
        INSERT INTO team_members (
          id, status, launch_operation_id, launch_kind, launch_started_at,
          launch_previous_session_id, launch_previous_status,
          launch_dispatch_recipe
        ) VALUES
          ('spawn', 'starting', 'op-spawn', 'spawn', now(), NULL, NULL,
            '{"version":1}'::jsonb),
	          ('revival', 'starting', 'op-revival', 'revival', now(), 'old-session',
	            'failed', '{"version":1}'::jsonb),
	          ('cleanup', 'starting', 'op-cleanup', 'spawn', now(), NULL, NULL,
	            '{"version":1}'::jsonb);
	        UPDATE team_members
	        SET launch_cleanup_requested_at = now(), launch_cleanup_action = 'purge'
	        WHERE id = 'cleanup';
	      `),
      ).resolves.toBeDefined();
    });

    it("rejects a revival without an exact terminal predecessor status", async () => {
      const database = await migratedClient();
      for (const [id, previousStatus] of [
        ["missing-status", "NULL"],
        ["active-status", "'idle'"],
      ]) {
        await expect(
          database.exec(`
          INSERT INTO team_members (
            id, status, launch_operation_id, launch_kind, launch_started_at,
            launch_previous_session_id, launch_previous_status,
            launch_dispatch_recipe
          ) VALUES (
            '${id}', 'starting', 'op-${id}', 'revival', now(),
            'old-session', ${previousStatus}, '{"version":1}'::jsonb
          );
        `),
        ).rejects.toThrow(/team_members_launch_metadata_consistent/);
      }
    });

    it("rejects JSON null and scalar launch recipes", async () => {
      const database = await migratedClient();
      for (const [id, recipe] of [
        ["json-null", "null"],
        ["json-string", '"recipe"'],
        ["json-array", "[]"],
      ]) {
        await expect(
          database.exec(`
          INSERT INTO team_members (
            id, status, launch_operation_id, launch_kind, launch_started_at,
            launch_previous_session_id, launch_previous_status,
            launch_dispatch_recipe
          ) VALUES (
            '${id}', 'starting', 'op-${id}', 'spawn', now(), NULL, NULL,
            '${recipe}'::jsonb
          );
        `),
        ).rejects.toThrow(/team_members_launch_metadata_consistent/);
      }
    });

    it("requires one valid cleanup action with every cleanup fence", async () => {
      const database = await migratedClient();
      for (const [id, cleanupTimestamp, cleanupAction] of [
        ["missing-action", "now()", "NULL"],
        ["missing-timestamp", "NULL", "'purge'"],
        ["invalid-action", "now()", "'delete'"],
      ]) {
        await expect(
          database.exec(`
					INSERT INTO team_members (
						id, status, launch_operation_id, launch_kind,
						launch_started_at, launch_cleanup_requested_at,
						launch_cleanup_action, launch_dispatch_recipe
					) VALUES (
						'${id}', 'starting', 'op-${id}', 'spawn', now(),
						${cleanupTimestamp}, ${cleanupAction}, '{"version":1}'::jsonb
					);
				`),
        ).rejects.toThrow(/team_members_launch_metadata_consistent/);
      }
    });
  },
);
