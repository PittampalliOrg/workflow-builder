import type { Handle } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import { env } from "$env/dynamic/private";
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { ensureStartupReady } from "$lib/server/startup";
import { getApplicationAdapters } from "$lib/server/application";
import { resolveWorkspaceProjectId } from "$lib/server/workspaces/resolve";
import { setSpanValue } from "$lib/server/observability/content";
import { activeHttpServerSpan } from "$lib/server/observability/http-server-spans";
import {
  operationNameForSpan,
  requestPayloadForSpan,
  responsePayloadForSpan,
  routeForSpan,
  shouldCaptureApiIo,
} from "$lib/server/observability/api-io";

// Kick the boot sequence at module load (runs once per server process). We
// don't await at module level so request handling isn't blocked if the DB is
// slow to answer — the startupHandle below gates every request on it.
if (!previewControlBrokerModeEnabled()) {
  ensureStartupReady().catch(() => {
    /* already logged */
  });
}

export function previewControlBrokerModeEnabled(): boolean {
  return (
    (env.PREVIEW_CONTROL_BROKER_MODE ?? process.env.PREVIEW_CONTROL_BROKER_MODE)
      ?.trim()
      .toLowerCase() === "true"
  );
}

/** Exact physical-control-plane surface. Preview-local reverse calls stay excluded. */
export const PREVIEW_CONTROL_BROKER_ROUTES = Object.freeze([
  ["POST", "/api/internal/preview-control/artifacts"],
  ["POST", "/api/internal/preview-control/accepted-images/reuse"],
  ["POST", "/api/internal/preview-control/activation-images"],
  ["POST", "/api/internal/preview-control/dev-sync-credentials"],
  ["POST", "/api/internal/preview-control/development-build"],
  ["POST", "/api/internal/preview-control/environment"],
  ["POST", "/api/internal/preview-control/deletion-intents/reconcile"],
  ["POST", "/api/internal/preview-control/infrastructure-candidate"],
  ["POST", "/api/internal/preview-control/pr-preview"],
  ["POST", "/api/internal/preview-control/acceptance"],
  ["POST", "/api/internal/preview-control/read"],
  ["POST", "/api/internal/preview-control/promotion"],
  ["POST", "/api/internal/preview-runtime/v1/chat/completions"],
] as const);

const PREVIEW_CONTROL_BROKER_DYNAMIC_ROUTES = Object.freeze([
  [
    "POST",
    /^\/api\/internal\/preview-control\/environment\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\/teardown$/,
  ],
  [
    "GET",
    /^\/api\/internal\/preview-control\/environment\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\/cleanup$/,
  ],
] as const);

const previewControlBrokerRouteKeys = new Set(
  PREVIEW_CONTROL_BROKER_ROUTES.map(
    ([routeMethod, routePath]) => `${routeMethod} ${routePath}`,
  ),
);

/** Return a response only when broker mode itself owns the request. */
export function previewControlBrokerModeResponse(
  pathname: string,
  method: string,
  enabled: boolean,
): Response | null {
  if (!enabled) return null;
  if (pathname === "/healthz") {
    if (method !== "GET" && method !== "HEAD") {
      return new Response(null, { status: 405 });
    }
    return new Response(
      method === "HEAD" ? null : JSON.stringify({ ok: true }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      },
    );
  }
  if (
    previewControlBrokerRouteKeys.has(`${method.toUpperCase()} ${pathname}`) ||
    PREVIEW_CONTROL_BROKER_DYNAMIC_ROUTES.some(
      ([routeMethod, pattern]) =>
        routeMethod === method.toUpperCase() && pattern.test(pathname),
    )
  ) {
    return null;
  }
  return new Response("Not found", { status: 404 });
}

const previewControlBrokerHandle: Handle = async ({ event, resolve }) => {
  const response = previewControlBrokerModeResponse(
    event.url.pathname,
    event.request.method,
    previewControlBrokerModeEnabled(),
  );
  return response ?? resolve(event);
};

const startupHandle: Handle = async ({ event, resolve }) => {
  if (previewControlBrokerModeEnabled()) return resolve(event);
  try {
    await ensureStartupReady();
  } catch {
    /* logged in startup.ts; let the request proceed so the error surfaces naturally */
  }
  return resolve(event);
};

const authHandle: Handle = async ({ event, resolve }) => {
  if (previewControlBrokerModeEnabled()) {
    event.locals.session = null;
    return resolve(event);
  }
  const adapters = getApplicationAdapters();
  const session = await adapters.authSession.getSession({
    request: event.request,
    cookies: event.cookies,
  });

  event.locals.session = session
    ? {
        userId: session.user.id,
        email: session.user.email,
        projectId: session.user.projectId,
        platformId: session.user.platformId,
      }
    : null;

  // Stale-JWT healing: when the JWT's `projectId` no longer exists in
  // project_members for this user (e.g. the database was reseeded but
  // the browser still holds an older signed JWT), the membership check
  // in resolveWorkspaceProjectId silently returns null and every
  // /workspaces/[slug] page 404s, including the OAuth callback resume.
  // Detect this case once per request, look up any project the user is
  // currently a member of, and patch locals.session.projectId in-place.
  // The JWT itself isn't rotated here — that happens on the next
  // /api/v1/auth/refresh — but the rest of the request sees a valid
  // projectId so the user can actually use the app.
  if (event.locals.session) {
    try {
      const resolvedProjectId =
        await adapters.workflowData.resolveSessionProjectId({
          userId: event.locals.session.userId,
          currentProjectId: event.locals.session.projectId,
        });
      if (
        resolvedProjectId &&
        resolvedProjectId !== event.locals.session.projectId
      ) {
        event.locals.session = {
          ...event.locals.session,
          projectId: resolvedProjectId,
        };
      }
    } catch {
      /* membership check is best-effort — never block the request */
    }
  }

  // CMA-parity workspace scope: when a request carries an X-Workspace
  // header (attached by the client-side fetch wrapper for any URL
  // under /workspaces/{slug}/…), OR when the page URL itself is
  // workspace-scoped, resolve the slug to the authoritative projectId
  // via project_members and override locals.session.projectId for this
  // request. Bad slugs (non-member access) silently fall back to the
  // JWT default — the layout-level guard at /workspaces/[slug]/
  // converts that into a visible 404 for page requests.
  if (event.locals.session) {
    const headerSlug = event.request.headers.get("x-workspace")?.trim();
    const urlMatch = event.url.pathname.match(/^\/workspaces\/([^/]+)\/?/);
    const slug = headerSlug || urlMatch?.[1] || null;
    if (slug && slug !== event.locals.session.projectId) {
      try {
        const resolved = await resolveWorkspaceProjectId(
          slug,
          event.locals.session.userId,
          event.locals.session.projectId,
        );
        if (resolved && resolved !== event.locals.session.projectId) {
          event.locals.session = {
            ...event.locals.session,
            projectId: resolved,
          };
        }
      } catch {
        /* ignore — membership check failures don't block the request */
      }
    }
  }

  return resolve(event);
};

const corsHandle: Handle = async ({ event, resolve }) => {
  // Handle preflight requests
  if (
    event.request.method === "OPTIONS" &&
    event.url.pathname.startsWith("/api/")
  ) {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods":
          "GET, POST, PUT, DELETE, PATCH, OPTIONS",
        "access-control-allow-headers": "Content-Type, Authorization",
        "access-control-max-age": "86400",
      },
    });
  }

  const response = await resolve(event);

  if (event.url.pathname.startsWith("/api/")) {
    response.headers.set("access-control-allow-origin", "*");
    response.headers.set(
      "access-control-allow-methods",
      "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    );
    response.headers.set(
      "access-control-allow-headers",
      "Content-Type, Authorization",
    );
  }

  return response;
};

const apiIoTracer = trace.getTracer("workflow-builder.api-io");

const apiIoHandle: Handle = async ({ event, resolve }) => {
  const method = event.request.method.toUpperCase();
  if (!shouldCaptureApiIo(event.url, method)) {
    return resolve(event);
  }

  const spanTargets = new Set<Span>();
  const activeSpan = trace.getActiveSpan();
  const httpServerSpan = activeHttpServerSpan();
  if (activeSpan) spanTargets.add(activeSpan);
  if (httpServerSpan) spanTargets.add(httpServerSpan);
  const requestPayload = await requestPayloadForSpan(event.request, event.url);
  const route = routeForSpan(event.url);
  for (const span of spanTargets) {
    span.setAttribute("http.request.method", method);
    span.setAttribute("url.path", event.url.pathname);
    span.setAttribute("http.route", route);
    setSpanValue(span, "input", requestPayload);
  }

  return apiIoTracer.startActiveSpan(
    operationNameForSpan(method, event.url),
    async (span) => {
      span.setAttribute("http.request.method", method);
      span.setAttribute("url.path", event.url.pathname);
      span.setAttribute("http.route", route);
      setSpanValue(span, "input", requestPayload);
      try {
        const response = await resolve(event);
        const responsePayload = await responsePayloadForSpan(response);
        span.setAttribute("http.response.status_code", response.status);
        setSpanValue(span, "output", responsePayload);
        for (const target of spanTargets) {
          target.setAttribute("http.response.status_code", response.status);
          setSpanValue(target, "output", responsePayload);
        }
        if (response.status >= 500) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${response.status}`,
          });
        }
        return response;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        throw error;
      } finally {
        span.end();
      }
    },
  );
};

export const handle = sequence(
  previewControlBrokerHandle,
  startupHandle,
  authHandle,
  apiIoHandle,
  corsHandle,
);
