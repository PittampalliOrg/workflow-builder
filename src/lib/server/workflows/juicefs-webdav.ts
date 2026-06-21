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

import { createHash } from "node:crypto";

const WEBDAV_BASE = (
  process.env.JUICEFS_WEBDAV_URL ||
  "http://juicefs-webdav.workflow-builder.svc.cluster.local:9007"
).replace(/\/$/, "");

// Basic-auth for the gateway. The gateway enables HTTP Basic auth when its
// WEBDAV_USER/WEBDAV_PASSWORD env are set (juicefs-webdav-creds Secret, written
// by the minio-creds-bootstrap Job). To avoid a secret-mount/restart ORDERING
// chicken-egg (BFF pod may start before that Secret exists), the BFF derives the
// SAME password deterministically from DATABASE_URL — the identical formula the
// bootstrap Job uses — so both sides agree without the BFF reading the Secret.
//   gateway pw == BFF pw == sha256("webdav:wfbcli:" + DATABASE_URL)[:32]
// User is the fixed `wfbwebdav`. If DATABASE_URL is absent (local dev, no auth on
// the gateway), we send no header and the gateway serves anonymously.
const WEBDAV_USER = process.env.JUICEFS_WEBDAV_USER || "wfbwebdav";
let _authHeader: string | null | undefined;
function authHeader(): string | null {
  if (_authHeader !== undefined) return _authHeader;
  const pw =
    process.env.JUICEFS_WEBDAV_PASSWORD ||
    (process.env.DATABASE_URL
      ? createHash("sha256")
          .update(`webdav:wfbcli:${process.env.DATABASE_URL}`)
          .digest("hex")
          .slice(0, 32)
      : "");
  _authHeader = pw
    ? `Basic ${Buffer.from(`${WEBDAV_USER}:${pw}`).toString("base64")}`
    : null;
  return _authHeader;
}

// Directories that are noise in a coding workspace tree.
const SKIP_DIR_SEGMENTS = new Set([".git", ".wfb-diff-git", "node_modules", ".cache", ".venv", "__pycache__"]);

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
/** List the IMMEDIATE children of one directory (`PROPFIND Depth: 1`). Paths
 * returned are relative to the instance root. Returns null on 404. */
async function listDir(
  instanceId: string,
  subpath: string,
): Promise<WebdavEntry[] | null> {
  const selfRel = subpath.replace(/^\/+|\/+$/g, "");
  const encodedSub = selfRel
    ? selfRel.split("/").map(encodeURIComponent).join("/") + "/"
    : "";
  const url = `${WEBDAV_BASE}/${encodeURIComponent(instanceId)}/${encodedSub}`;
  const auth = authHeader();
  const res = await fetch(url, {
    method: "PROPFIND",
    headers: {
      Depth: "1",
      "Content-Type": "application/xml",
      ...(auth ? { Authorization: auth } : {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok && res.status !== 207) throw new Error(`webdav PROPFIND ${res.status}`);
  const xml = await res.text();
  const prefix = `/${instanceId}/`;

  const out: WebdavEntry[] = [];
  for (const block of xml.split(/<\/?D:response>/i).filter((b) => /<D:href>/i.test(b))) {
    const hrefMatch = block.match(/<D:href>([^<]*)<\/D:href>/i);
    if (!hrefMatch) continue;
    const href = decodeHref(hrefMatch[1]);
    const idx = href.indexOf(prefix);
    if (idx === -1) continue;
    const rel = href.slice(idx + prefix.length).replace(/\/$/, "");
    if (rel === "" || rel === selfRel) continue; // skip the directory itself
    // Matches <D:collection/>, <D:collection />, and <D:collection xmlns:D="DAV:"/>.
    const isDir = /<D:collection[\s/>]/i.test(block);
    const sizeMatch = block.match(/<D:getcontentlength>(\d+)<\/D:getcontentlength>/i);
    out.push({ path: rel, isDir, sizeBytes: sizeMatch ? parseInt(sizeMatch[1], 10) : 0 });
  }
  return out;
}

/**
 * List an instance's workspace subtree as a bounded breadth-first walk of
 * `Depth: 1` listings. CRITICAL: never recurses into VCS/dependency dirs
 * (`node_modules` etc.) — a single `Depth: infinity` makes juicefs-webdav walk
 * all of node_modules (1700+ entries, 90s+ timeout). Caps entries + PROPFINDs.
 * Returns paths RELATIVE to the instance root.
 */
export async function listWorkspaceTree(
  instanceId: string,
  opts: { maxEntries?: number; maxPropfinds?: number; concurrency?: number } = {},
): Promise<{ entries: WebdavEntry[]; truncated: boolean }> {
  const maxEntries = opts.maxEntries ?? 2000;
  const maxPropfinds = opts.maxPropfinds ?? 300;
  const concurrency = opts.concurrency ?? 6;

  const root = await listDir(instanceId, "");
  if (root === null) return { entries: [], truncated: false };

  const entries: WebdavEntry[] = [];
  let truncated = false;
  const queue: string[] = []; // dir paths to expand next

  const ingest = (children: WebdavEntry[]) => {
    for (const c of children) {
      // Never list or recurse into node_modules/.git/... (avoids the slow walk).
      if (c.isDir && SKIP_DIR_SEGMENTS.has(c.path.split("/").pop() ?? "")) continue;
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      entries.push(c);
      if (c.isDir) queue.push(c.path);
    }
  };

  ingest(root);
  let propfinds = 1;
  while (queue.length && entries.length < maxEntries && propfinds < maxPropfinds) {
    const batch = queue.splice(0, concurrency);
    propfinds += batch.length;
    const results = await Promise.all(
      batch.map((d) => listDir(instanceId, d).catch(() => [] as WebdavEntry[])),
    );
    for (const children of results) ingest(children ?? []);
  }
  if (queue.length) truncated = true;
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
  const auth = authHeader();
  const res = await fetch(url, {
    method: "GET",
    ...(auth ? { headers: { Authorization: auth } } : {}),
  });
  if (!res.ok) return null;
  return {
    bytes: await res.arrayBuffer(),
    contentType: res.headers.get("content-type") || "application/octet-stream",
  };
}
