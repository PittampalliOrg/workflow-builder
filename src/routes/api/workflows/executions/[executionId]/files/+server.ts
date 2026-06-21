/**
 * GET /api/workflows/executions/[executionId]/files
 *
 * Persisted output files for a run, for the run-detail "Files" tab. Resolves
 * the execution's sessions and returns the durable `files` rows scoped to them
 * (purpose='output') — these survive the per-session pod being reaped. Also
 * returns a `liveSandbox` candidate (a non-terminal session's sandbox name) so
 * the UI can offer the LIVE workspace tree (via SandboxFileBrowser) while the
 * pod is still up, falling back to the persisted list otherwise.
 *
 * Workspace-scoped via `assertInScope`. Cross-workspace access 404s.
 */

import { error, json } from "@sveltejs/kit";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import { files, sessions, workflowExecutions } from "$lib/server/db/schema";
import { assertInScope } from "$lib/server/workflows/project-scope";

// Session statuses for which the per-session pod may still be alive (so the
// live workspace tree is worth offering). Anything else → persisted only.
const NON_TERMINAL_STATUSES = new Set([
  "running",
  "active",
  "provisioning",
  "rescheduling",
  "starting",
  "paused",
  "idle",
]);

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!db) return error(503, "Database not configured");
  if (!locals.session?.userId) return error(401, "Authentication required");

  const { executionId } = params;
  if (!executionId) return error(400, "executionId required");

  // Workspace-scope check via the parent execution row.
  const execRows = await db
    .select({
      id: workflowExecutions.id,
      projectId: workflowExecutions.projectId,
      userId: workflowExecutions.userId,
    })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId))
    .limit(1);
  assertInScope(execRows[0], locals.session, "Execution not found");

  // Execution → its sessions (output files are scoped to session ids; some
  // runtimes scope directly to the execution id, so include both).
  const sessRows = await db
    .select({
      id: sessions.id,
      status: sessions.status,
      sandboxName: sessions.sandboxName,
      workspaceSandboxName: sessions.workspaceSandboxName,
      runtimeSandboxName: sessions.runtimeSandboxName,
      runtimeAppId: sessions.runtimeAppId,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .where(eq(sessions.workflowExecutionId, executionId))
    .orderBy(desc(sessions.updatedAt));

  const scopeIds = [executionId, ...sessRows.map((s) => s.id)];

  const fileRows = await db
    .select({
      id: files.id,
      name: files.name,
      contentType: files.contentType,
      sizeBytes: files.sizeBytes,
      createdAt: files.createdAt,
    })
    .from(files)
    .where(
      and(
        inArray(files.scopeId, scopeIds),
        eq(files.purpose, "output"),
        isNull(files.archivedAt),
      ),
    )
    .orderBy(desc(files.createdAt))
    .limit(500);

  // CLI-family runs (claude/codex/agy) keep their working files on the shared
  // JuiceFS mount (/sandbox/work) — browsable durably via juicefs-webdav. Detect
  // them so the UI uses the workspace-files tree (live AND after pod reap)
  // instead of the openshell exec path (which can't read CLI pods).
  const CLI_SLUGS = new Set(["claude-code-cli", "codex-cli", "agy-cli"]);
  const cliWorkspace = sessRows.some(
    (s) =>
      CLI_SLUGS.has(String(s.sandboxName ?? "")) ||
      String(s.runtimeAppId ?? "").startsWith("agent-session-"),
  );

  // Openshell live-tree candidate: ONLY the openshell workspace sandbox name
  // (workspace-*), which `/api/sandboxes/[name]/files` can exec into. The other
  // name columns carry runtime slugs / pod names that endpoint can't serve.
  let liveSandbox: { name: string } | null = null;
  if (!cliWorkspace) {
    for (const s of sessRows) {
      if (!NON_TERMINAL_STATUSES.has(String(s.status ?? "").toLowerCase())) continue;
      if (s.workspaceSandboxName) {
        liveSandbox = { name: s.workspaceSandboxName };
        break;
      }
    }
  }

  return json({ files: fileRows, liveSandbox, cliWorkspace });
};
