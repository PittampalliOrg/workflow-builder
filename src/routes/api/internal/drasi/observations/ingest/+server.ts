import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { normalizeDrasiObservation } from "$lib/server/application/drasi-observations";
import { validateDrasiIncidentIngestToken } from "$lib/server/internal-auth";

const MAX_REQUEST_BYTES = 16_384;

export const POST: RequestHandler = async ({ request }) => {
  if (!validateDrasiIncidentIngestToken(request)) {
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

  const normalized = normalizeDrasiObservation(body);
  if (!normalized.ok) {
    return json({ error: normalized.error }, { status: 400 });
  }

  try {
    const events = getApplicationAdapters().gitOpsActivityEvents;
    const currentEvent = await events.ingest(normalized.currentEvent);
    const event = await events.ingest(
      normalized.event,
    );
    return json(
      {
        accepted: true,
        eventId: event.eventId,
        currentStateEventId: currentEvent.eventId,
      },
      { status: 202 },
    );
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "ingest failed" },
      { status: 502 },
    );
  }
};
