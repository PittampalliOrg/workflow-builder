import { env } from "$env/dynamic/private";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { normalizeDrasiIncident } from "$lib/server/application/drasi-incidents";
import { getEventBusAdapter } from "$lib/server/application/event-bus";
import { validateInternalToken } from "$lib/server/internal-auth";

const MAX_REQUEST_BYTES = 32_768;

export const POST: RequestHandler = async ({ request }) => {
  if (!validateInternalToken(request)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    return json({ error: `body exceeds ${MAX_REQUEST_BYTES} bytes` }, { status: 413 });
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) {
    return json({ error: `body exceeds ${MAX_REQUEST_BYTES} bytes` }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "body must be valid JSON" }, { status: 400 });
  }

  const normalized = normalizeDrasiIncident(body, {
    workflowName: env.DRASI_INCIDENT_WORKFLOW_NAME || "platform-incident-analysis",
    cluster: env.CLUSTER_NAME || "dev",
  });
  if (!normalized.ok) {
    return json({ error: normalized.error }, { status: 400 });
  }

  try {
    await getEventBusAdapter().publish("workflow.triggers", normalized.envelope);
    return json(
      { accepted: true, dedupKey: normalized.envelope.dedupKey },
      { status: 202 },
    );
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "publish failed" },
      { status: 502 },
    );
  }
};
