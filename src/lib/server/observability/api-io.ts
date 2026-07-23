const API_IO_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const REMOTE_IO_METHODS = new Set(["GET", "POST"]);
const BROWSER_ARTIFACT_UPLOAD_PATH = /^\/api\/internal\/browser-artifacts$/;
const BROWSER_SCREENSHOT_RESPONSE_PATH =
  /^\/api\/internal\/observability\/executions\/[^/]+\/browser-artifacts\/screenshot$/;

function isRemotePath(pathname: string): boolean {
  return pathname.startsWith("/_app/remote/");
}

function remoteCallName(url: URL): string | undefined {
  const parts = url.pathname.split("/").filter(Boolean);
  const encoded = parts[3];
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function queryObject(
  url: URL,
  omit = new Set<string>(),
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (omit.has(key)) continue;
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

function decodeRemotePayload(raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return "[remote payload decode failed]";
  }
}

export function shouldCaptureApiIo(url: URL, method: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if (url.pathname.startsWith("/api/"))
    return API_IO_METHODS.has(normalizedMethod);
  if (isRemotePath(url.pathname))
    return REMOTE_IO_METHODS.has(normalizedMethod);
  return false;
}

export function routeForSpan(url: URL): string {
  const name = remoteCallName(url);
  if (isRemotePath(url.pathname) && name) return `/_app/remote/:id/${name}`;
  return url.pathname;
}

export function operationNameForSpan(method: string, url: URL): string {
  const normalizedMethod = method.toUpperCase();
  const name = remoteCallName(url);
  if (isRemotePath(url.pathname) && name) {
    return `workflow-builder.remote ${normalizedMethod} ${name}`;
  }
  return `workflow-builder.api ${normalizedMethod} ${url.pathname}`;
}

export async function requestPayloadForSpan(
  request: Request,
  url: URL,
): Promise<unknown> {
  const method = request.method.toUpperCase();
  const isRemote = isRemotePath(url.pathname);
  const base = {
    method,
    path: routeForSpan(url),
    query: queryObject(url, isRemote ? new Set(["payload"]) : undefined),
  };
  if (isRemote) {
    const payload = decodeRemotePayload(url.searchParams.get("payload"));
    return {
      ...base,
      remoteCall: remoteCallName(url),
      ...(payload === undefined ? {} : { payload }),
    };
  }
  if (method === "GET" || method === "HEAD") return base;
  if (method === "POST" && BROWSER_ARTIFACT_UPLOAD_PATH.test(url.pathname)) {
    return { ...base, body: "[browser artifact payload omitted]" };
  }

  const contentType = request.headers.get("content-type") ?? "";
  try {
    const text = await request.clone().text();
    if (!text.trim()) return { ...base, body: "" };
    if (contentType.includes("json")) {
      try {
        return { ...base, body: JSON.parse(text) };
      } catch {
        return { ...base, body: text };
      }
    }
    if (
      contentType.includes("text/") ||
      contentType.includes("application/x-www-form-urlencoded")
    ) {
      return { ...base, body: text };
    }
    return {
      ...base,
      contentType,
      body: contentType ? "[non-json request body]" : text,
    };
  } catch {
    return { ...base, body: "[request body capture failed]" };
  }
}

export async function responsePayloadForSpan(
  response: Response,
  url: URL,
): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const base = {
    status: response.status,
    contentType: contentType || undefined,
  };
  if (response.ok && BROWSER_SCREENSHOT_RESPONSE_PATH.test(url.pathname)) {
    return { ...base, body: "[browser screenshot payload omitted]" };
  }
  if (contentType.includes("text/event-stream") || response.body == null) {
    return {
      ...base,
      body: response.body == null ? "" : "[streaming response omitted]",
    };
  }
  if (
    response.ok &&
    contentType &&
    !contentType.includes("json") &&
    !contentType.includes("text/")
  ) {
    return { ...base, body: "[non-text response body]" };
  }

  try {
    const text = await response.clone().text();
    if (!text.trim()) return { ...base, body: "" };
    if (contentType.includes("json")) {
      try {
        return { ...base, body: JSON.parse(text) };
      } catch {
        return { ...base, body: text };
      }
    }
    if (contentType.includes("text/")) {
      return { ...base, body: text };
    }
    return { ...base, body: "[non-text response body]" };
  } catch {
    return { ...base, body: "[response capture failed]" };
  }
}
