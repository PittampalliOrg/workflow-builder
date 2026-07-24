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

const DEFAULT_WEBDAV_BASE =
  "http://juicefs-webdav.workflow-builder.svc.cluster.local:9007";

export type JuiceFsWebdavConfig = {
  baseUrl?: string | null;
  username?: string | null;
  password?: string | null;
};

// Directories that are noise in a coding workspace tree.
const SKIP_DIR_SEGMENTS = new Set([
  ".git",
  ".wfb-diff-git",
  "node_modules",
  ".cache",
  ".venv",
  "__pycache__",
]);

export interface WebdavEntry {
  /** Path relative to the instance root (no leading slash). "" is the root. */
  path: string;
  isDir: boolean;
  sizeBytes: number;
}

export function createJuiceFsWebdavClient(config: JuiceFsWebdavConfig = {}) {
  const baseUrl = (config.baseUrl || DEFAULT_WEBDAV_BASE).replace(/\/$/, "");
  const auth = config.password
    ? `Basic ${Buffer.from(`${config.username || "wfbwebdav"}:${config.password}`).toString("base64")}`
    : null;

  return {
    listWorkspaceTree: (
      instanceId: string,
      opts?: {
        maxEntries?: number;
        maxPropfinds?: number;
        concurrency?: number;
      },
    ) => listWorkspaceTreeWithConfig(baseUrl, auth, instanceId, opts),
    readWorkspaceFile: (instanceId: string, relPath: string) =>
      readWorkspaceFileWithConfig(baseUrl, auth, instanceId, relPath),
    /**
     * List the node-boundary snapshot ids recorded for one workspace key
     * (durability phase 3). Snapshots live at the filesystem ROOT under
     * `.snapshots/<key>/<snapshotId>/`, alongside the per-instance workspaces —
     * a single `Depth:1` PROPFIND lists them. Returns [] when the key has no
     * snapshots (the `.snapshots/<key>` dir is absent → 404).
     */
    listSnapshots: (workspaceKey: string) =>
      listSnapshotsWithConfig(baseUrl, auth, workspaceKey),
  };
}

async function listSnapshotsWithConfig(
  baseUrl: string,
  auth: string | null,
  workspaceKey: string,
): Promise<string[]> {
  // `.snapshots` is the collection; `workspaceKey` its child dir. listDir treats
  // its 3rd arg as the first path segment, so pass ".snapshots" there and the key
  // as the subpath → PROPFIND `/.snapshots/<key>/`.
  const children = await listDir(baseUrl, auth, ".snapshots", workspaceKey);
  if (children === null) return [];
  const out: string[] = [];
  for (const c of children) {
    if (!c.isDir) continue;
    const leaf = c.path.split("/").pop() ?? "";
    if (leaf) out.push(leaf);
  }
  return out;
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
  baseUrl: string,
  auth: string | null,
  instanceId: string,
  subpath: string,
): Promise<WebdavEntry[] | null> {
  const selfRel = subpath.replace(/^\/+|\/+$/g, "");
  const encodedSub = selfRel
    ? selfRel.split("/").map(encodeURIComponent).join("/") + "/"
    : "";
  const url = `${baseUrl}/${encodeURIComponent(instanceId)}/${encodedSub}`;
  const res = await fetch(url, {
    method: "PROPFIND",
    headers: {
      Depth: "1",
      "Content-Type": "application/xml",
      ...(auth ? { Authorization: auth } : {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok && res.status !== 207)
    throw new Error(`webdav PROPFIND ${res.status}`);
  const xml = await res.text();
  const prefix = `/${instanceId}/`;

  const out: WebdavEntry[] = [];
  for (const block of xml
    .split(/<\/?D:response>/i)
    .filter((b) => /<D:href>/i.test(b))) {
    const hrefMatch = block.match(/<D:href>([^<]*)<\/D:href>/i);
    if (!hrefMatch) continue;
    const href = decodeHref(hrefMatch[1]);
    const idx = href.indexOf(prefix);
    if (idx === -1) continue;
    const rel = href.slice(idx + prefix.length).replace(/\/$/, "");
    if (rel === "" || rel === selfRel) continue; // skip the directory itself
    // Matches <D:collection/>, <D:collection />, and <D:collection xmlns:D="DAV:"/>.
    const isDir = /<D:collection[\s/>]/i.test(block);
    const sizeMatch = block.match(
      /<D:getcontentlength>(\d+)<\/D:getcontentlength>/i,
    );
    out.push({
      path: rel,
      isDir,
      sizeBytes: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
    });
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
  opts: {
    maxEntries?: number;
    maxPropfinds?: number;
    concurrency?: number;
  } = {},
): Promise<{ entries: WebdavEntry[]; truncated: boolean }> {
  return createJuiceFsWebdavClient().listWorkspaceTree(instanceId, opts);
}

async function listWorkspaceTreeWithConfig(
  baseUrl: string,
  auth: string | null,
  instanceId: string,
  opts: {
    maxEntries?: number;
    maxPropfinds?: number;
    concurrency?: number;
  } = {},
): Promise<{ entries: WebdavEntry[]; truncated: boolean }> {
  const maxEntries = opts.maxEntries ?? 2000;
  const maxPropfinds = opts.maxPropfinds ?? 300;
  const concurrency = opts.concurrency ?? 6;

  const root = await listDir(baseUrl, auth, instanceId, "");
  if (root === null) return { entries: [], truncated: false };

  const entries: WebdavEntry[] = [];
  let truncated = false;
  const queue: string[] = []; // dir paths to expand next

  const ingest = (children: WebdavEntry[]) => {
    for (const c of children) {
      // Never list or recurse into node_modules/.git/... (avoids the slow walk).
      if (c.isDir && SKIP_DIR_SEGMENTS.has(c.path.split("/").pop() ?? ""))
        continue;
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
  while (
    queue.length &&
    entries.length < maxEntries &&
    propfinds < maxPropfinds
  ) {
    const batch = queue.splice(0, concurrency);
    propfinds += batch.length;
    const results = await Promise.all(
      batch.map((d) =>
        listDir(baseUrl, auth, instanceId, d).catch(() => [] as WebdavEntry[]),
      ),
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
  return createJuiceFsWebdavClient().readWorkspaceFile(instanceId, relPath);
}

async function readWorkspaceFileWithConfig(
  baseUrl: string,
  auth: string | null,
  instanceId: string,
  relPath: string,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  const clean = relPath.replace(/^\/+/, "");
  // Defense-in-depth against traversal out of the instance subtree.
  if (clean.split("/").some((s) => s === "..")) return null;
  const url = `${baseUrl}/${encodeURIComponent(instanceId)}/${clean
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
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
