import { json } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import { PreviewWorkspaceContractError } from "$lib/server/application/preview-workspace";
import { requirePreviewActionInternal } from "$lib/server/internal-auth";

const SAFE_OPERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_SERVICE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_COMMAND = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type PreviewWorkspaceHttpMode = "seed" | "sync" | "run";

export async function handlePreviewWorkspaceAction(input: {
  mode: PreviewWorkspaceHttpMode;
  rawExecutionId: string | undefined;
  request: Request;
}): Promise<Response> {
  requirePreviewActionInternal(input.request);
  if (!input.rawExecutionId) {
    return json({ error: "execution id is required" }, { status: 400 });
  }
  const operationId =
    input.request.headers.get("x-idempotency-key")?.trim() ?? "";
  if (!SAFE_OPERATION.test(operationId)) {
    return json({ error: "idempotency key is required" }, { status: 400 });
  }
  let body: Record<string, unknown>;
  try {
    const parsed = await input.request.json();
    body =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    return json({ error: "JSON object body is required" }, { status: 400 });
  }
  const allowed =
    input.mode === "run"
      ? new Set(["service", "command"])
      : new Set(["service"]);
  if (
    Object.keys(body).some((key) => !allowed.has(key)) ||
    typeof body.service !== "string" ||
    !SAFE_SERVICE.test(body.service) ||
    (input.mode === "run" &&
      (typeof body.command !== "string" || !SAFE_COMMAND.test(body.command)))
  ) {
    return json(
      { error: "preview workspace action input is invalid" },
      { status: 400 },
    );
  }
  const app = getApplicationAdapters();
  const executionId = await app.workflowData.resolveCanonicalExecutionId({
    executionId: input.rawExecutionId,
  });
  try {
    const result =
      input.mode === "seed"
        ? await app.previewWorkspace.seed({
            executionId,
            service: body.service,
            operationId,
          })
        : input.mode === "sync"
          ? await app.previewWorkspace.sync({
              executionId,
              service: body.service,
              operationId,
            })
          : await app.previewWorkspace.run({
              executionId,
              service: body.service,
              command: body.command,
              operationId,
            });
    return json(result);
  } catch (cause) {
    const status =
      cause instanceof PreviewWorkspaceContractError ? cause.status : 502;
    const message =
      cause instanceof PreviewWorkspaceContractError
        ? cause.message
        : "preview workspace operation failed";
    return json({ error: message }, { status });
  }
}
