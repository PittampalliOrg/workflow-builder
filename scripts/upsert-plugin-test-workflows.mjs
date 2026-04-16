/**
 * Upsert the dapr-agent-py e2e plugin test workflows.
 *
 * Usage (from workflow-builder pod or local with DATABASE_URL):
 *   DATABASE_URL=... node scripts/upsert-plugin-test-workflows.mjs
 *
 * Reads every services/dapr-agent-py/tests/e2e/*.workflow.json and
 * upserts it into the `workflows` table, matching the existing
 * greenfield-sveltekit upsert script conventions.
 */

import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
const E2E_DIR = path.resolve(
  process.cwd(),
  "services/dapr-agent-py/tests/e2e",
);

function parseArgs(argv) {
  let userEmail = "";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--user-email") {
      userEmail = String(argv[i + 1] || "").trim();
      i += 1;
    }
  }
  return { userEmail };
}

async function resolveOwner(sql, existing, userEmail) {
  if (existing?.user_id) {
    return { userId: existing.user_id, projectId: existing.project_id || null };
  }
  if (userEmail) {
    const rows = await sql`
      select u.id as user_id, pm.project_id
      from users u left join project_members pm on pm.user_id = u.id
      where lower(u.email) = lower(${userEmail})
      order by pm.created_at asc nulls last limit 1`;
    if (rows[0]?.user_id) {
      return { userId: rows[0].user_id, projectId: rows[0].project_id || null };
    }
  }
  const rows = await sql`
    select pm.user_id, pm.project_id from project_members pm
    order by pm.created_at asc limit 1`;
  if (rows[0]?.user_id) {
    return { userId: rows[0].user_id, projectId: rows[0].project_id || null };
  }
  const userRows = await sql`
    select id as user_id from users order by created_at asc limit 1`;
  if (userRows[0]?.user_id) return { userId: userRows[0].user_id, projectId: null };
  throw new Error("Could not resolve a workflow owner.");
}

async function upsertOne(sql, wf, userEmail) {
  const workflowId = wf.id;
  const existing = await sql`
    select id, user_id, project_id from workflows where id = ${workflowId} limit 1`;
  const owner = await resolveOwner(sql, existing[0] ?? null, userEmail);

  if (existing[0]) {
    await sql`
      update workflows set
        name = ${wf.name},
        description = ${wf.description || ""},
        nodes = ${sql.json(wf.nodes || [])},
        edges = ${sql.json(wf.edges || [])},
        visibility = ${wf.visibility || "public"},
        spec = ${sql.json(wf.spec || null)},
        updated_at = now()
      where id = ${workflowId}`;
    return { workflowId, created: false, name: wf.name };
  }
  await sql`
    insert into workflows
      (id, name, description, nodes, edges, visibility, spec, user_id, project_id, created_at, updated_at)
    values
      (${workflowId}, ${wf.name}, ${wf.description || ""},
       ${sql.json(wf.nodes || [])}, ${sql.json(wf.edges || [])},
       ${wf.visibility || "public"}, ${sql.json(wf.spec || null)},
       ${owner.userId}, ${owner.projectId}, now(), now())`;
  return { workflowId, created: true, name: wf.name };
}

async function main() {
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
  const args = parseArgs(process.argv.slice(2));
  const sql = postgres(DATABASE_URL, { max: 1 });

  try {
    const entries = await fs.readdir(E2E_DIR);
    const files = entries
      .filter((f) => f.endsWith(".workflow.json"))
      .map((f) => path.join(E2E_DIR, f))
      .sort();

    if (files.length === 0) {
      throw new Error(`No *.workflow.json files in ${E2E_DIR}`);
    }

    const results = [];
    for (const file of files) {
      const raw = await fs.readFile(file, "utf-8");
      const wf = JSON.parse(raw);
      const res = await upsertOne(sql, wf, args.userEmail);
      results.push({ ...res, file: path.basename(file) });
    }
    console.log(JSON.stringify({ count: results.length, results }, null, 2));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error("[upsert-plugin-test-workflows] Error:", error);
  process.exitCode = 1;
});
