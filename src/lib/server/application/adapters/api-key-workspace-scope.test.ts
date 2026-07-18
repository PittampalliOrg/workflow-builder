import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresApiKeyStore,
  PostgresWorkspaceProjectRepository,
} from "$lib/server/application/adapters/postgres";

const migrationPaths = [
  "drizzle/0109_api_key_workspace_scope.sql",
  "atlas/migrations/20260718170000_api_key_workspace_scope.sql",
];

describe("API key workspace-scope migrations", () => {
  for (const migrationPath of migrationPaths) {
    it(`${migrationPath} preserves legacy keys while adding workspace scope`, () => {
      const source = readFileSync(
        resolve(process.cwd(), migrationPath),
        "utf8",
      );

      expect(source).toContain('ADD COLUMN IF NOT EXISTS "project_id" text');
      expect(source).toContain(
        'ADD COLUMN IF NOT EXISTS "scopes" text[] DEFAULT',
      );
      expect(source).toContain("'{}' NOT NULL");
      expect(source).toContain('SET "created_by_user_id" = "user_id"');
      expect(source).not.toContain(
        'ALTER COLUMN "created_by_user_id" SET NOT NULL',
      );
      expect(source).not.toMatch(/SET\s+"project_id"/);
    });
  }

  it("keeps management creator-scoped and preserves legacy scope on rotation", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/server/application/adapters/postgres.ts"),
      "utf8",
    );
    const creatorGuards =
      source.match(/eq\(apiKeys\.createdByUserId, input\.userId\)/g) ?? [];

    expect(creatorGuards.length).toBeGreaterThanOrEqual(3);
    expect(source).not.toContain(
      "coalesce(${apiKeys.projectId}, ${input.projectId})",
    );
    expect(source).not.toContain("legacyUpgradeScopes");
  });
});

describe("PostgresApiKeyStore workspace scope", () => {
  let client: PGlite;
  let store: PostgresApiKeyStore;
  let workspaceProjects: PostgresWorkspaceProjectRepository;

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(`
			CREATE TABLE users (id text PRIMARY KEY, status text DEFAULT 'ACTIVE');
			CREATE TABLE projects (id text PRIMARY KEY);
			CREATE TABLE project_members (
				id text PRIMARY KEY,
				project_id text NOT NULL REFERENCES projects(id),
				user_id text NOT NULL REFERENCES users(id)
			);
			CREATE TABLE api_keys (
				id text PRIMARY KEY,
				user_id text NOT NULL REFERENCES users(id),
				name text,
				key_hash text NOT NULL,
				key_prefix text NOT NULL,
				created_at timestamp DEFAULT now() NOT NULL,
				last_used_at timestamp
			);
			INSERT INTO users(id, status) VALUES
				('user-1', 'ACTIVE'), ('user-2', 'ACTIVE'), ('user-3', 'INACTIVE');
			INSERT INTO projects(id) VALUES ('project-1');
			INSERT INTO project_members(id, project_id, user_id) VALUES
				('member-1', 'project-1', 'user-1'),
				('member-2', 'project-1', 'user-2'),
				('member-3', 'project-1', 'user-3');
			INSERT INTO api_keys(id, user_id, name, key_hash, key_prefix)
				VALUES ('legacy-1', 'user-1', 'Legacy', 'legacy-hash', 'wfb_old...');
		`);
    await client.exec(
      readFileSync(resolve(process.cwd(), migrationPaths[0]), "utf8"),
    );
    await client.exec(`
			INSERT INTO api_keys(id, user_id, name, key_hash, key_prefix)
				VALUES ('rolling-legacy-1', 'user-1', 'Rolling legacy',
					'rolling-legacy-hash', 'wfb_roll...');
			INSERT INTO api_keys(
				id, user_id, project_id, created_by_user_id, scopes,
				name, key_hash, key_prefix
			) VALUES
				('own-1', 'user-1', 'project-1', 'user-1',
				 ARRAY['workflow:read'], 'Own', 'own-hash', 'wfb_own...'),
				('other-1', 'user-2', 'project-1', 'user-2',
				 ARRAY['workflow:read'], 'Other', 'other-hash', 'wfb_other...');
		`);
    store = new PostgresApiKeyStore(drizzle(client) as never);
    workspaceProjects = new PostgresWorkspaceProjectRepository(
      drizzle(client) as never,
    );
  });

  afterEach(async () => {
    await client.close();
  });

  it("lists and manages only keys created by the caller", async () => {
    const visible = await store.listVisibleInProject({
      userId: "user-1",
      projectId: "project-1",
    });
    expect(visible.map((key) => key.id).sort()).toEqual([
      "legacy-1",
      "own-1",
      "rolling-legacy-1",
    ]);
    await expect(
      store.getByKeyHash("rolling-legacy-hash"),
    ).resolves.toMatchObject({ createdByUserId: "user-1" });

    await expect(
      store.deleteForProject({
        id: "other-1",
        userId: "user-1",
        projectId: "project-1",
      }),
    ).resolves.toBe(false);
    await expect(
      store.updateSecretForProject({
        id: "other-1",
        userId: "user-1",
        projectId: "project-1",
        keyHash: "stolen-hash",
        keyPrefix: "wfb_stolen...",
      }),
    ).resolves.toBeNull();
  });

  it("preserves a legacy key's owner scope on rotation", async () => {
    const rotated = await store.updateSecretForProject({
      id: "legacy-1",
      userId: "user-1",
      projectId: "project-1",
      keyHash: "rotated-hash",
      keyPrefix: "wfb_rotated...",
    });
    expect(rotated).toMatchObject({
      id: "legacy-1",
      projectId: null,
      createdByUserId: "user-1",
      scopes: [],
    });
    await expect(store.getByKeyHash("rotated-hash")).resolves.toMatchObject({
      id: "legacy-1",
      projectId: null,
    });
    await expect(
      workspaceProjects.hasActiveProjectMembership({
        projectId: "project-1",
        userId: "user-1",
      }),
    ).resolves.toBe(true);
    await expect(
      workspaceProjects.hasActiveProjectMembership({
        projectId: "project-1",
        userId: "user-3",
      }),
    ).resolves.toBe(false);
  });
});
