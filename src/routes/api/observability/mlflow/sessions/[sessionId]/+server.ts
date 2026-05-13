import { error, json, redirect, type RequestHandler } from "@sveltejs/kit";
import {
  getMlflowTraceGroupForSession,
  publicMlflowTraceRedirectUrl,
} from "$lib/server/observability/mlflow";

export const GET: RequestHandler = async ({ params, url }) => {
  const sessionId = params.sessionId?.trim();
  if (!sessionId) return error(400, "Session id is required");
  if (url.searchParams.get("format") === "json") {
    const group = await getMlflowTraceGroupForSession(sessionId);
    if (!group) return error(404, "Session not found");
    return json(group);
  }

  const href = await publicMlflowTraceRedirectUrl({ sessionId });
  if (!href) return error(503, "MLflow trace UI is not configured");
  return redirect(302, href);
};
