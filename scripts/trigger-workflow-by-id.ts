/**
 * Trigger a workflow execution by workflow ID (or latest) against a RUNNING BFF.
 *
 * Mints a short-lived RS256 access token for the workflow's owner (same shape as
 * src/lib/server/auth.ts::generateTokens) and POSTs the real execute route, so
 * all server-side logic runs (agent-ref resolution, input defaults, greenfield
 * expansion, MLflow/trace wiring). This replaces the old DB-direct trigger,
 * whose generateWorkflowDefinition/genericOrchestratorClient helpers no longer
 * exist (workflows now store a `spec` column sent to the orchestrator).
 *
 * Usage (typically over port-forwards to dev postgres + BFF):
 *   DATABASE_URL=postgres://postgres:password@127.0.0.1:5432/workflow_builder \
 *   JWT_SIGNING_KEY="$(kubectl ... get the PKCS8 PEM ...)" \
 *   BFF_URL=http://127.0.0.1:3000 \
 *     pnpm tsx scripts/trigger-workflow-by-id.ts <workflowId> [--input '{"k":"v"}']
 *
 * If <workflowId> is omitted, the most recently updated workflow is used.
 */
import postgres from "postgres";
import { SignJWT, importPKCS8 } from "jose";

const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SIGNING_KEY = process.env.JWT_SIGNING_KEY;
const BFF_URL = (process.env.BFF_URL || "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
if (!DATABASE_URL) throw new Error("DATABASE_URL required");
if (!JWT_SIGNING_KEY) throw new Error("JWT_SIGNING_KEY required");

// Parse args: [workflowId] [--input '<json>']
const argv = process.argv.slice(2);
let workflowId: string | undefined;
let inputJson = "{}";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--input") {
    inputJson = argv[++i] ?? "{}";
  } else if (!workflowId) {
    workflowId = a;
  }
}
let triggerInput: Record<string, unknown>;
try {
  triggerInput = JSON.parse(inputJson);
} catch (e) {
  throw new Error(`--input is not valid JSON: ${String(e)}`);
}

const sql = postgres(DATABASE_URL, { max: 1 });

async function main() {
  const wfRows = workflowId
    ? await sql`
        select id, name, user_id, project_id
        from workflows where id = ${workflowId} limit 1`
    : await sql`
        select id, name, user_id, project_id
        from workflows order by updated_at desc limit 1`;
  const wf = wfRows[0];
  if (!wf) throw new Error(`No workflow found${workflowId ? `: ${workflowId}` : ""}`);

  // platform_id + email live on `users`; token_version on `user_identities`.
  const userRows = await sql`
    select email, platform_id from users where id = ${wf.user_id} limit 1`;
  const user = userRows[0];
  if (!user) throw new Error(`No users row for owner ${wf.user_id}`);
  const platformId = user.platform_id ?? "default-platform";

  const identRows = await sql`
    select token_version from user_identities where user_id = ${wf.user_id} limit 1`;
  const tokenVersion = identRows[0]?.token_version ?? 0;

  const privateKey = await importPKCS8(JWT_SIGNING_KEY!, "RS256");
  const accessToken = await new SignJWT({
    sub: wf.user_id,
    email: user.email ?? "",
    platformId,
    projectId: wf.project_id ?? "",
    tokenVersion,
    type: "access",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);

  console.log("Triggering:", wf.name, wf.id);
  console.log("  owner:", user.email, "platform:", platformId);

  const res = await fetch(`${BFF_URL}/api/workflows/${wf.id}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ input: triggerInput }),
  });

  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON */
  }

  console.log("HTTP", res.status);
  if (!res.ok) {
    console.error("Trigger failed:", text.slice(0, 800));
    process.exitCode = 1;
    return;
  }
  console.log("Execution:", parsed?.executionId);
  console.log("Instance:", parsed?.instanceId);
  console.log("");
  console.log("=== View in UI ===");
  console.log(`${BFF_URL}/workflows/${wf.id}/runs/${parsed?.executionId}`);
}

main()
  .catch((err) => {
    console.error("Fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
  });
