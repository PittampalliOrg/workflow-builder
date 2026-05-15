import { error, json, redirect, type RequestHandler } from "@sveltejs/kit";
import { getMlflowTraceGroupForSession } from "$lib/server/observability/mlflow";

export const GET: RequestHandler = async ({ params, url }) => {
  const sessionId = params.sessionId?.trim();
  if (!sessionId) return error(400, "Session id is required");
  const group = await getMlflowTraceGroupForSession(sessionId);
  if (!group) return error(404, "Session not found");
  if (url.searchParams.get("format") === "json") {
    return json(group);
  }

  const target = url.searchParams.get("target")?.trim().toLowerCase();
  const href =
    target === "run"
      ? group.runUrl
      : target === "traces"
        ? group.traceSearchUrl
        : group.sessionUrl ?? group.runUrl ?? group.traceSearchUrl;
  if (!href) {
    return error(
      503,
      "No MLflow session link is configured for this session yet.",
    );
  }
  return redirect(302, href);
};
