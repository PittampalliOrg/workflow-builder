/**
 * Minimal WebDAV client for the in-cluster JuiceFS gateway (juicefs-webdav),
 * which serves the `wfbcli` filesystem over HTTP. Used by the run-page Files
 * tree to browse/read a run's shared CLI workspace under
 * `/<daprInstanceId>/...` durably — during a run AND after the per-session pod
 * is reaped — without exec-ing into the ephemeral pod.
 *
 * The gateway exposes the WHOLE filesystem, so callers MUST confine every read
 * to the requesting execution's instance subtree (see workspace-files route).
 */

const WEBDAV_BASE = (
  process.env.JUICEFS_WEBDAV_URL ||
  "http://juicefs-webdav.workflow-builder.svc.cluster.local:9007"
).replace(/\/$/, "");

// Directories that are noise in a coding workspace tree.
const SKIP_DIR_SEGMENTS = new Set([".git", "node_modules", ".cache", ".venv", "__pycache__"]);

export interface WebdavEntry {
  /** Path relative to the instance root (no leading slash). "" is the root. */
  path: string;
  isDir: boolean;
  sizeBytes: number;
}

function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/**
 * Recursively list an instance's workspace subtree via a single
 * `PROPFIND Depth: infinity`. Filters VCS/dependency noise and caps the entry
 * count. Returns paths RELATIVE to the instance root.
 */
export async function listWorkspaceTree(
  instanceId: string,
  opts: { maxEntries?: number } = {},
): Promise<{ entries: WebdavEntry[]; truncated: boolean }> {
  const maxEntries = opts.maxEntries ?? 2000;
  const root = `${WEBDAV_BASE}/${encodeURIComponent(instanceId)}/`;
  const res = await fetch(root, {
    method: "PROPFIND",
    headers: { Depth: "infinity", "Content-Type": "application/xml" },
  });
  if (res.status === 404) return { entries: [], truncated: false };
  if (!res.ok && res.status !== 207) {
    throw new Error(`webdav PROPFIND ${res.status}`);
  }
  const xml = await res.text();
  const prefix = `/${instanceId}/`;

  const entries: WebdavEntry[] = [];
  let truncated = false;
  // The body is a regular <D:multistatus> of <D:response> blocks.
  for (const block of xml.split(/<\/?D:response>/i).filter((b) => /<D:href>/i.test(b))) {
    const hrefMatch = block.match(/<D:href>([^<]*)<\/D:href>/i);
    if (!hrefMatch) continue;
    const href = decodeHref(hrefMatch[1]);
    // Confine to this instance's subtree; derive the relative path.
    const idx = href.indexOf(prefix);
    if (idx === -1) continue;
    let rel = href.slice(idx + prefix.length);
    rel = rel.replace(/\/$/, "");
    if (rel === "") continue; // the root itself
    const segments = rel.split("/");
    if (segments.some((s) => SKIP_DIR_SEGMENTS.has(s))) continue;
    // Matches <D:collection/>, <D:collection />, and <D:collection xmlns:D="DAV:"/>.
    const isDir = /<D:collection[\s/>]/i.test(block);
    const sizeMatch = block.match(/<D:getcontentlength>(\d+)<\/D:getcontentlength>/i);
    const sizeBytes = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
    entries.push({ path: rel, isDir, sizeBytes });
    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
  }
  return { entries, truncated };
}

/** Read one file's bytes from an instance's workspace subtree. */
export async function readWorkspaceFile(
  instanceId: string,
  relPath: string,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  const clean = relPath.replace(/^\/+/, "");
  // Defense-in-depth against traversal out of the instance subtree.
  if (clean.split("/").some((s) => s === "..")) return null;
  const url = `${WEBDAV_BASE}/${encodeURIComponent(instanceId)}/${clean
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) return null;
  return {
    bytes: await res.arrayBuffer(),
    contentType: res.headers.get("content-type") || "application/octet-stream",
  };
}
