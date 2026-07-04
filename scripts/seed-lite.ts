/**
 * Seed a lite-profile PGlite data directory so `pnpm dev:lite` has a working
 * sign-in + a workspace to render on first boot.
 *
 * The schema must already exist — build it first with `pnpm db:push-lite`
 * (drizzle-kit push of schema.ts head). This script only inserts data:
 * one platform / user / credential identity / project / membership / sample
 * workflow. When SEED_JWT_PUBLIC_KEY is supplied (see scripts/dev-lite.sh) it
 * also seeds the signing_keys row that JWT verification reads, so password
 * sign-in works end-to-end.
 *
 * PGlite is single-connection and single-process: run this BEFORE starting the
 * dev server (both open the same data dir), never concurrently.
 *
 * Usage:
 *   pnpm db:push-lite && pnpm seed:lite    # -> ./.pglite-data
 *   DATABASE_URL=pglite://./x pnpm seed:lite
 */
import { sql } from "drizzle-orm";
import { createPgliteDb } from "../src/lib/server/db/pglite-compat";

const PLATFORM_ID = "default-platform";
const USER_ID = "lite-dev-user";
const IDENTITY_ID = "lite-dev-identity";
const PROJECT_ID = "lite-dev-project";
const MEMBER_ID = "lite-dev-member";
const WORKFLOW_ID = "lite-sample-workflow";

const EMAIL = process.env.SEED_LITE_EMAIL ?? "dev@workflow-builder.local";
const PASSWORD = process.env.SEED_LITE_PASSWORD ?? "devpassword";

function resolveDataDir(): string {
	const url = process.env.DATABASE_URL;
	if (url?.startsWith("pglite://")) {
		const spec = url.slice("pglite://".length);
		if (spec === "" || spec === "memory" || spec === "memory://") {
			throw new Error("seed-lite requires a persistent data dir (not pglite://memory)");
		}
		return spec;
	}
	return "./.pglite-data";
}

async function seed(db: ReturnType<typeof createPgliteDb>["db"]): Promise<void> {
	const bcrypt = await import("bcryptjs");
	const passwordHash = await bcrypt.hash(PASSWORD, 10);

	await db.execute(sql`
		INSERT INTO platforms (id, name) VALUES (${PLATFORM_ID}, 'Lite Dev Platform')
		ON CONFLICT (id) DO NOTHING
	`);
	await db.execute(sql`
		INSERT INTO users (id, name, email, email_verified, created_at, updated_at, platform_id, platform_role, status)
		VALUES (${USER_ID}, 'Lite Dev', ${EMAIL}, true, now(), now(), ${PLATFORM_ID}, 'ADMIN', 'ACTIVE')
		ON CONFLICT (id) DO NOTHING
	`);
	await db.execute(sql`
		INSERT INTO user_identities (id, user_id, email, password, provider, verified)
		VALUES (${IDENTITY_ID}, ${USER_ID}, ${EMAIL}, ${passwordHash}, 'credentials', true)
		ON CONFLICT (id) DO UPDATE SET password = EXCLUDED.password
	`);
	await db.execute(sql`
		INSERT INTO projects (id, platform_id, owner_id, display_name, external_id)
		VALUES (${PROJECT_ID}, ${PLATFORM_ID}, ${USER_ID}, 'Lite Dev Workspace', 'lite-dev-workspace')
		ON CONFLICT (id) DO NOTHING
	`);
	await db.execute(sql`
		INSERT INTO project_members (id, project_id, user_id, role)
		VALUES (${MEMBER_ID}, ${PROJECT_ID}, ${USER_ID}, 'ADMIN')
		ON CONFLICT (id) DO NOTHING
	`);
	await db.execute(sql`
		INSERT INTO workflows (id, name, description, user_id, project_id, nodes, edges, visibility, engine_type)
		VALUES (
			${WORKFLOW_ID}, 'Sample Workflow', 'Seeded by pnpm dev:lite', ${USER_ID}, ${PROJECT_ID},
			'[]'::jsonb, '[]'::jsonb, 'private', 'dapr'
		)
		ON CONFLICT (id) DO NOTHING
	`);

	const publicKey = process.env.SEED_JWT_PUBLIC_KEY;
	if (publicKey) {
		await db.execute(sql`
			INSERT INTO signing_keys (id, platform_id, public_key, algorithm, display_name)
			VALUES ('lite-dev-signing-key', ${PLATFORM_ID}, ${publicKey}, 'RS256', 'lite-dev')
			ON CONFLICT (id) DO UPDATE SET public_key = EXCLUDED.public_key
		`);
		console.log("[seed-lite] seeded signing_keys row (password sign-in enabled)");
	} else {
		console.log("[seed-lite] SEED_JWT_PUBLIC_KEY unset — sign-in will 302-redirect (data seeded)");
	}

	console.log(`[seed-lite] seeded user ${EMAIL} / project Lite Dev Workspace / 1 workflow`);
}

async function main(): Promise<void> {
	const dataDir = resolveDataDir();
	const { db, sql: rawSql } = createPgliteDb(dataDir);
	// Fail early with a clear message if the schema was not pushed first.
	try {
		await db.execute(sql`SELECT 1 FROM users LIMIT 1`);
	} catch {
		throw new Error(
			`schema not found in ${dataDir} — run 'pnpm db:push-lite' before seeding`,
		);
	}
	await seed(db);
	await rawSql.end();
	console.log(`[seed-lite] done -> ${dataDir}`);
}

main().catch((err) => {
	console.error("[seed-lite] failed:", err instanceof Error ? err.message : err);
	process.exit(1);
});
