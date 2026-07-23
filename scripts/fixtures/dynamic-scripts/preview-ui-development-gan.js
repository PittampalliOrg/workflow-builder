export const meta = {
  name: "preview-ui-development-gan",
  description:
    "Preview-local automated UI development loop for workflow-builder: enter the existing app-live preview's live-sync mode, use a policy-selected Kimi K3 builder profile to implement a cohesive UI change, verify the HMR-served app, snapshot the exact live-sync generation, and open a draft PR.",
  phases: [
    { title: "Dev mode" },
    { title: "Plan" },
    { title: "Generate" },
    { title: "Verify" },
    { title: "Promote" },
  ],
  launch: { surface: "dev-environment" },
  estimatedAgentCalls: 2,
  input: {
    type: "object",
    required: ["intent"],
    additionalProperties: false,
    properties: {
      intent: {
        type: "string",
        title: "Dashboard development task",
        minLength: 1,
        maxLength: 12000,
        description:
          "The host-submitted request. It describes desired code changes only and cannot override preview authority, HMR, capture, or promotion rules.",
      },
      service: { type: "string", default: "workflow-builder" },
      services: {
        type: "array",
        items: { type: "string" },
        default: ["workflow-builder"],
      },
      targetRoutes: {
        type: "array",
        minItems: 1,
        maxItems: 16,
        uniqueItems: true,
        items: {
          type: "string",
          pattern: "^/(?:[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*)?$",
        },
        default: ["/dashboard"],
      },
      maxIterations: { type: "integer", minimum: 1, maximum: 3, default: 2 },
      builderProfile: {
        type: "string",
        enum: ["kimi-k3-juicefs", "pydantic-ai-k3-ui"],
        default: "kimi-k3-juicefs",
        description:
          "Policy-selected builder identity and runtime. Arbitrary agent slugs and runtimes are not accepted.",
      },
      keepPreview: {
        anyOf: [{ type: "boolean" }, { type: "string", enum: ["true", "false"] }],
        default: "true",
      },
      ttlHours: {
        type: "integer",
        title: "Retained sandbox lifetime in hours",
        minimum: 2,
        maximum: 24,
        default: 24,
        description:
          "Only used when retainAfterCompletion is true: the preview sandbox self-delete backstop becomes ttlHours * 3600 seconds (clamped to the platform sandbox ceiling).",
      },
      retainAfterCompletion: {
        anyOf: [{ type: "boolean" }, { type: "string", enum: ["true", "false"] }],
        default: false,
        title: "Retain preview after completion",
        description:
          "When true, size the sandbox lifetime from ttlHours and freeze live-sync after promotion (unless interactiveHandoff keeps it open).",
      },
      interactiveHandoff: {
        anyOf: [{ type: "boolean" }, { type: "string", enum: ["true", "false"] }],
        default: false,
        title: "Hand off to an interactive session",
        description:
          "When true, skip the post-promotion freeze and spawn a persistent interactive agent session against the retained preview.",
      },
      impactReview: {
        anyOf: [{ type: "boolean" }, { type: "string", enum: ["true", "false"] }],
        default: false,
        title: "Run multi-service impact-review gates",
        description:
          "Multi-service only. When true, after each generation run workflow-side convergence, route-smoke, and per-service probe gates (and diffScope enforcement) BEFORE accepting the capture; a gate failure feeds the next iteration exactly like a capture failure. Ignored on the single-service path, which keeps its proven behavior byte-for-byte.",
      },
      diffScope: {
        type: "array",
        items: { type: "string" },
        title: "Captured-path allowlist",
        description:
          "Optional path-prefix allowlist enforced against each receiver's final adopted-source diff before snapshot (multi-service only). Source files outside these prefixes fail the iteration with skip reason out_of_scope_changes. Generated build artifacts are always excluded. When omitted (with impactReview on) it defaults to each service's synced source roots.",
      },
      mode: {
        type: "string",
        enum: ["preview-native"],
        description:
          "Server-derived launch mode injected by the preview launch policy.",
      },
      previewOrigin: {
        type: "string",
        description:
          "Server-derived canonical preview origin injected by the preview launch policy.",
      },
      sourceRevision: {
        type: "string",
        pattern: "^[0-9a-f]{40}$",
        description:
          "Server-derived source revision injected by the preview launch policy.",
      },
      __previewDevelopment: {
        type: "object",
        additionalProperties: true,
        description:
          "Server-derived tuple binding injected by the preview development control plane.",
      },
    },
  },
};

const REQUIRED_MODEL = "kimi/kimi-k3";
const DEFAULT_SERVICE = "workflow-builder";
const DEFAULT_ROUTES = ["/dashboard"];
const DASHBOARD_MARKER = "Preview Development Status";
const DEFAULT_BUILDER_PROFILE = "kimi-k3-juicefs";
const BUILDER_PROFILES = {
  "kimi-k3-juicefs": {
    agentSlug: "kimi-k3-juicefs-builder-agent",
    agentType: "dapr-agent-py-juicefs",
    maxTurns: 24,
    timeoutMinutes: 35,
  },
  "pydantic-ai-k3-ui": {
    agentSlug: "pydantic-ai-k3-preview-ui-builder-agent",
    agentType: "pydantic-ai-agent-py",
    maxTurns: 120,
    timeoutMinutes: 60,
  },
};

// Phase 3 per-service /__run probe lanes, duplicated read-only from the
// dev-preview registry (dev-preview-registry.ts `testCommands`). That registry
// file is a preview-gate UNSUPPORTED path (services/shared/dev-preview-service-
// catalog.json unsupportedPathPrefixes), so it cannot be edited on this
// preview-gated PR path — the map is mirrored here instead. Services ABSENT from
// this map (function-router, mcp-gateway, workflow-mcp-server, …) have no
// testCommands, so their probe is health-poll ONLY; never invent a /__run lane
// for them (the sidecar would 404).
const PROBE_LANES = {
  "workflow-builder": ["check", "test-unit"],
  "workflow-orchestrator": ["contract"],
};

// Generated build artifacts that churn into diffs (the PR #688 class). They are
// ALWAYS excluded from the diffScope check — a change to one neither satisfies
// nor violates scope; it is dropped from the changed-path set entirely.
function isGeneratedArtifact(path) {
  return (
    path === "scripts/seed-workflows.bundle.js" ||
    path.endsWith("/seed-workflows.bundle.js") ||
    path === "services/shared/dev-preview-service-catalog.json" ||
    path.endsWith("/dev-preview-service-catalog.json") ||
    path === "drizzle/meta/_journal.json" ||
    path.endsWith("/drizzle/meta/_journal.json")
  );
}

function isSafeServiceName(name) {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name);
}

// ---- Pure impact-review gate parsers (unit-tested through the fixture) --------

// Unwrap a workspace/command result into {exitCode, stdout, stderr}. Handles both
// the direct `{ success, result: {...} }` envelope and the allowFailure `{ data }`
// nesting; a failing action nests its payload under `data` (dataOf() unwraps it).
function unwrapCommand(res) {
  const base = dataOf(res);
  const inner =
    base && typeof base === "object" && base.result && typeof base.result === "object"
      ? base.result
      : base;
  const rawExit = inner?.exitCode ?? base?.exitCode;
  const exitCode = Number.isFinite(Number(rawExit))
    ? Number(rawExit)
    : inner?.ok === false || base?.ok === false
      ? 1
      : 0;
  const stdout = String(inner?.stdout ?? inner?.output ?? base?.stdout ?? "");
  const stderr = String(inner?.stderr ?? base?.stderr ?? "");
  return { exitCode, stdout, stderr };
}

// Parse sync.sh's OWN receipts from the agent-produced sync.log: an `APPLIED …
// (service=<svc> …)` line for every expected service AND a final
// `SYNCED generation=<g> services=<N> convergence=healthy` line whose N matches.
function parseConvergence(stdout, expectedServices) {
  const applied = new Set();
  let synced = null;
  for (const line of String(stdout).split("\n")) {
    if (line.startsWith("APPLIED")) {
      const m = line.match(/\bservice=([^\s)]+)/);
      if (m) applied.add(m[1]);
    } else {
      const m = line.match(/^SYNCED generation=(\S+) services=(\d+) convergence=healthy\s*$/);
      if (m) synced = { generation: m[1], services: Number(m[2]) };
    }
  }
  const missing = expectedServices.filter((s) => !applied.has(s));
  let reason = "";
  if (!synced) reason = "convergence_unhealthy";
  else if (synced.services !== expectedServices.length)
    reason = "convergence_service_count_mismatch";
  else if (missing.length > 0) reason = "convergence_missing_service";
  return {
    ok: reason === "",
    reason,
    generation: synced?.generation ?? null,
    applied: [...applied],
    missing,
  };
}

// Parse `SMOKE kind=… http=… [marker=…]` lines. A gate FAILS on any unreachable
// (http 000/missing) or 5xx probe, or any route serving ReferenceError /
// each_key_duplicate.
function parseRouteSmoke(stdout) {
  const lines = String(stdout)
    .split("\n")
    .filter((l) => l.startsWith("SMOKE"));
  const failures = [];
  for (const line of lines) {
    const kind = (line.match(/\bkind=(\S+)/) || [])[1] ?? "smoke";
    const httpRaw = (line.match(/\bhttp=(\S+)/) || [])[1];
    const http = Number(httpRaw);
    const who =
      (line.match(/\broute=(\S+)/) || [])[1] ??
      (line.match(/\bservice=(\S+)/) || [])[1] ??
      "unknown";
    if (!Number.isFinite(http) || http === 0) {
      failures.push(`${kind} ${who} unreachable (http=${httpRaw ?? "none"})`);
      continue;
    }
    if (http >= 500) {
      failures.push(`${kind} ${who} returned HTTP ${http}`);
      continue;
    }
    const marker = (line.match(/\bmarker=(\S+)/) || [])[1];
    if (kind === "route" && marker && marker !== "none") {
      failures.push(`route ${who} served ${marker}`);
    }
  }
  return { ok: lines.length > 0 && failures.length === 0, failures, checked: lines.length };
}

// Parse `PROBE kind=lane|health …` lines. A lane FAILS on a nonzero exit; a
// health probe FAILS on unreachable/5xx.
function parseProbe(stdout) {
  const lines = String(stdout)
    .split("\n")
    .filter((l) => l.startsWith("PROBE"));
  const failures = [];
  for (const line of lines) {
    const kind = (line.match(/\bkind=(\S+)/) || [])[1];
    const service = (line.match(/\bservice=(\S+)/) || [])[1] ?? "unknown";
    if (kind === "lane") {
      const lane = (line.match(/\blane=(\S+)/) || [])[1] ?? "?";
      const exit = Number((line.match(/\bexit=(\S+)/) || [])[1]);
      if (!Number.isFinite(exit) || exit !== 0) {
        failures.push(`${service} lane ${lane} exit=${Number.isFinite(exit) ? exit : "none"}`);
      }
    } else if (kind === "health") {
      const httpRaw = (line.match(/\bhttp=(\S+)/) || [])[1];
      const http = Number(httpRaw);
      if (!Number.isFinite(http) || http === 0 || http >= 500) {
        failures.push(`${service} health http=${httpRaw ?? "none"}`);
      }
    }
  }
  return { ok: lines.length > 0 && failures.length === 0, failures, checked: lines.length };
}

function normalizeReceiverPath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("invalid receiver source path");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("invalid receiver source path");
  }
  return parts.join("/");
}

function normalizeRepositoryPath(base, relative) {
  if (
    typeof base !== "string" ||
    typeof relative !== "string" ||
    base.startsWith("/") ||
    relative.startsWith("/") ||
    base.includes("\\") ||
    relative.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(base + relative)
  ) {
    throw new Error("invalid repository source path");
  }
  const parts = [];
  for (const part of `${base}/${relative}`.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0)
        throw new Error("repository source path escapes root");
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  if (parts.length === 0) throw new Error("repository source path is empty");
  return parts.join("/");
}

function diffScopeReceivers(preview, requestedServices) {
  return requestedServices.map((service) => {
    if (!isSafeServiceName(service))
      throw new Error("invalid diffScope service");
    const info = serviceInfo(preview, service);
    const syncUrl = String(info.syncUrl ?? "").trim();
    const syncCapability = String(info.syncCapability ?? "").trim();
    const statusUrl = syncUrl.replace(/\/__sync\/?$/, "/__status");
    if (
      !/^http:\/\/[^\s]+\/__sync\/?$/.test(syncUrl) ||
      statusUrl === syncUrl ||
      !/^[a-f0-9]{64}$/.test(syncCapability)
    ) {
      throw new Error(
        `diffScope receiver metadata is incomplete for ${service}`,
      );
    }
    const repoSubdir =
      typeof info.repoSubdir === "string" && info.repoSubdir
        ? info.repoSubdir
        : ".";
    const mappings = [];
    const addMapping = (from, to) => {
      const receiverRoot = normalizeReceiverPath(from);
      const repositoryRoot = normalizeRepositoryPath(repoSubdir, to);
      const existing = mappings.find(
        (mapping) => mapping.receiverRoot === receiverRoot,
      );
      if (existing && existing.repositoryRoot !== repositoryRoot) {
        throw new Error(
          `conflicting diffScope mapping for ${service}:${receiverRoot}`,
        );
      }
      if (!existing) mappings.push({ receiverRoot, repositoryRoot });
    };
    const syncPaths =
      Array.isArray(info.syncPaths) && info.syncPaths.length
        ? info.syncPaths
        : ["src"];
    for (const syncPath of syncPaths) addMapping(syncPath, syncPath);
    for (const mapping of [
      ...(Array.isArray(info.extraSync) ? info.extraSync : []),
      ...(Array.isArray(info.captureOnly) ? info.captureOnly : []),
    ]) {
      if (!mapping || typeof mapping !== "object") {
        throw new Error(`invalid diffScope mapping for ${service}`);
      }
      addMapping(mapping.to, mapping.from);
    }
    mappings.sort(
      (left, right) =>
        right.receiverRoot.length - left.receiverRoot.length ||
        left.receiverRoot.localeCompare(right.receiverRoot),
    );
    return { service, statusUrl, syncCapability, mappings };
  });
}

function mapReceiverSourcePath(receiver, value) {
  const sourcePath = normalizeReceiverPath(value);
  const mapping = receiver.mappings.find(
    (candidate) =>
      sourcePath === candidate.receiverRoot ||
      sourcePath.startsWith(candidate.receiverRoot + "/"),
  );
  if (!mapping)
    throw new Error(
      `unmapped receiver source path ${receiver.service}:${sourcePath}`,
    );
  const suffix = sourcePath
    .slice(mapping.receiverRoot.length)
    .replace(/^\/+/, "");
  return suffix
    ? normalizeRepositoryPath(mapping.repositoryRoot, suffix)
    : mapping.repositoryRoot;
}

function parseDiffScopeReceipts(stdout, receivers, expectedGeneration) {
  const errors = [];
  const receipts = new Map();
  for (const raw of String(stdout).split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith("DIFFSCOPE-RECEIPT ")) continue;
    const match = line.match(
      /^DIFFSCOPE-RECEIPT service=(\S+) http=(\S+) body=(.*)$/,
    );
    if (!match) {
      errors.push("malformed diffScope receiver receipt");
      continue;
    }
    const [, service, http, bodyText] = match;
    const receiver = receivers.find(
      (candidate) => candidate.service === service,
    );
    if (!receiver || receipts.has(service)) {
      errors.push(`unexpected or duplicate diffScope receipt for ${service}`);
      continue;
    }
    if (http !== "200") {
      errors.push(`${service} diffScope status HTTP ${http}`);
      continue;
    }
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      errors.push(`${service} diffScope status was not JSON`);
      continue;
    }
    const generation = String(body?.generation ?? "");
    const paths = body?.sourceChangedPaths;
    const count = body?.sourceChangedPathCount;
    if (
      body?.ok !== true ||
      body?.syncService !== service ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(generation) ||
      typeof body?.sourceBaselineSha256 !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(body.sourceBaselineSha256) ||
      !Array.isArray(paths) ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      body?.sourceChangedPathsTruncated !== false ||
      count !== paths.length ||
      new Set(paths).size !== paths.length
    ) {
      errors.push(
        `${service} diffScope status contract is invalid or truncated`,
      );
      continue;
    }
    const repositoryPaths = [];
    try {
      for (const sourcePath of paths) {
        repositoryPaths.push(mapReceiverSourcePath(receiver, sourcePath));
      }
    } catch (error) {
      errors.push(String(error?.message ?? error));
      continue;
    }
    receipts.set(service, {
      service,
      generation,
      sourceBaselineSha256: body.sourceBaselineSha256,
      sourceChangedPathCount: count,
      repositoryPaths,
    });
  }
  for (const receiver of receivers) {
    if (!receipts.has(receiver.service)) {
      errors.push(`missing diffScope receiver receipt for ${receiver.service}`);
    }
  }
  const generations = new Set(
    [...receipts.values()].map((receipt) => receipt.generation),
  );
  const generation = generations.size === 1 ? [...generations][0] : null;
  if (generations.size > 1)
    errors.push("diffScope receiver generations do not converge");
  if (expectedGeneration && generation !== expectedGeneration) {
    errors.push(
      `diffScope generation ${generation ?? "none"} does not match ${expectedGeneration}`,
    );
  }
  const changed = [
    ...new Set(
      [...receipts.values()].flatMap((receipt) => receipt.repositoryPaths),
    ),
  ].sort();
  return {
    ok: errors.length === 0,
    errors,
    generation,
    changed,
    receipts: [...receipts.values()].map((receipt) => ({
      service: receipt.service,
      generation: receipt.generation,
      sourceBaselineSha256: receipt.sourceBaselineSha256,
      sourceChangedPathCount: receipt.sourceChangedPathCount,
    })),
  };
}

function inAllowlist(path, allow) {
  return allow.some((prefix) => {
    const p = String(prefix).replace(/\/+$/, "");
    return path === p || path.startsWith(p + "/");
  });
}

// Split changed paths into excluded (generated artifacts, always dropped),
// inScope (matches the allowlist), and outOfScope (the churn the gate rejects).
function classifyDiffScope(paths, allow) {
  const outOfScope = [];
  const excluded = [];
  const inScope = [];
  for (const path of paths) {
    if (isGeneratedArtifact(path)) excluded.push(path);
    else if (inAllowlist(path, allow)) inScope.push(path);
    else outOfScope.push(path);
  }
  return { outOfScope, excluded, inScope };
}

// ---- Impact-review gate shell commands (marker-prefixed for identification) ---

function convergenceCommand() {
  return (
    "# impact-review-convergence\n" +
    "if [ -f /sandbox/work/sync.log ]; then\n" +
    "  grep -E '^(APPLIED|SYNCED|convergence failed|convergence skipped|sync transaction pending)' /sandbox/work/sync.log || true\n" +
    "else\n" +
    "  echo 'MISSING sync.log'\n" +
    "fi\n"
  );
}

function smokeCommand(routeList, previewUrl) {
  const routes = routeList.filter((r) => typeof r === "string").map((r) => shq(r)).join(" ");
  return (
    "# impact-review-smoke\n" +
    "set +e\n" +
    "for _cfg in /sandbox/work/.syncenv.d/*; do\n" +
    '  [ -f "$_cfg" ] || continue\n' +
    "  SERVICE='' HEALTHURL=''\n" +
    '  . "$_cfg"\n' +
    '  _svc=${SERVICE:-$(basename "$_cfg")}\n' +
    "  _code=000\n" +
    "  for _i in $(seq 1 30); do\n" +
    '    _code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$HEALTHURL" 2>/dev/null || echo 000)\n' +
    '    case "$_code" in 2*|3*|4*) break ;; esac\n' +
    "    sleep 2\n" +
    "  done\n" +
    '  echo "SMOKE kind=health service=$_svc http=$_code"\n' +
    "done\n" +
    "PREVIEW_URL=" +
    shq(previewUrl) +
    "\n" +
    "for _route in " +
    routes +
    "; do\n" +
    "  _body=$(mktemp)\n" +
    '  _code=$(curl -sS -o "$_body" -w "%{http_code}" --max-time 20 "$PREVIEW_URL$_route" 2>/dev/null || echo 000)\n' +
    "  _marker=none\n" +
    '  grep -q "ReferenceError" "$_body" 2>/dev/null && _marker=ReferenceError\n' +
    '  grep -q "each_key_duplicate" "$_body" 2>/dev/null && _marker=each_key_duplicate\n' +
    '  echo "SMOKE kind=route route=$_route http=$_code marker=$_marker"\n' +
    '  rm -f "$_body"\n' +
    "done\n"
  );
}

function probeCommand(requestedServices) {
  let body = "# impact-review-probe\nset +e\n";
  for (const svc of requestedServices) {
    if (!isSafeServiceName(svc)) continue;
    const lanes = PROBE_LANES[svc];
    body += `if [ -f /sandbox/work/.syncenv.d/${svc} ]; then\n`;
    body += "  ( SERVICE='' SYNCURL='' HEALTHURL='' SYNC_TOKEN=''\n";
    body += `    . /sandbox/work/.syncenv.d/${svc}\n`;
    body += "    _base=${SYNCURL%/__sync}\n";
    if (lanes && lanes.length) {
      body += "    _lane_failed=0\n";
      for (const lane of lanes) {
        body += '    if [ "$_lane_failed" -eq 0 ]; then\n';
        body += `    _out=$(curl -sS -X POST -H "x-sync-token: $SYNC_TOKEN" --max-time 600 "$_base/__run?cmd=${lane}" 2>/dev/null)\n`;
        body +=
          "    _exit=$(printf '%s' \"$_out\" | sed -n 's/.*\"exitCode\":[[:space:]]*\\([0-9-][0-9]*\\).*/\\1/p' | head -1)\n";
        body += '    [ -n "$_exit" ] || _exit=1\n';
        body += `    echo "PROBE kind=lane service=${svc} lane=${lane} exit=$_exit"\n`;
        body += '    [ "$_exit" -eq 0 ] || _lane_failed=1\n';
        body += "    fi\n";
      }
    } else {
      body +=
        '    _code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 "$HEALTHURL" 2>/dev/null || echo 000)\n';
      body += `    echo "PROBE kind=health service=${svc} http=$_code"\n`;
    }
    body += `  )\nelse\n  echo "PROBE kind=health service=${svc} http=000"\nfi\n`;
  }
  return body;
}

function diffScopeCommand(receivers) {
  let body = "# impact-review-diffscope\nset +e\n";
  for (const receiver of receivers) {
    body += "_diffscope_body=$(mktemp)\n";
    body += 'if [ -n "$_diffscope_body" ]; then\n';
    body += `  _diffscope_http=$(curl -sS -o "$_diffscope_body" -w "%{http_code}" --max-time 30 -H ${shq(`x-sync-token: ${receiver.syncCapability}`)} ${shq(receiver.statusUrl)} 2>/dev/null)\n`;
    body += "  _diffscope_curl=$?\n";
    body += '  [ "$_diffscope_curl" -eq 0 ] || _diffscope_http=000\n';
    body += `  printf 'DIFFSCOPE-RECEIPT service=${receiver.service} http=%s body=' "$_diffscope_http"\n`;
    body += "  tr -d '\\r\\n' < \"$_diffscope_body\"\n";
    body += "  printf '\\n'\n";
    body += '  rm -f "$_diffscope_body"\n';
    body += "else\n";
    body += `  echo 'DIFFSCOPE-RECEIPT service=${receiver.service} http=000 body={}'\n`;
    body += "fi\n";
  }
  return body;
}

function dataOf(value) {
  return value?.data ?? value ?? {};
}

function stateOf(value) {
  return String(value?.status ?? value?.phase ?? "").trim().toLowerCase();
}

function failureOf(value) {
  if (value?.ok === false) return String(value.error ?? value.message ?? "operation failed");
  const state = stateOf(value);
  if (["failed", "error", "blocked", "cancelled"].includes(state)) {
    return String(value?.error ?? value?.message ?? `operation entered ${state}`);
  }
  return "";
}

function asStringArray(value, fallback) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : fallback;
}

function serviceInfo(preview, service) {
  const base = dataOf(preview);
  const entry = Array.isArray(base.services)
    ? base.services.find((candidate) => candidate?.service === service)
    : null;
  return dataOf(entry?.info ?? entry ?? base);
}

function agentOptions(label, builder, extra = {}) {
  return {
    label,
    agent: builder.agentSlug,
    agentType: builder.agentType,
    model: REQUIRED_MODEL,
    effort: "max",
    isolation: "shared",
    sandbox: {
      workspaceRef: workspace,
      cwd: "/sandbox/work",
      maxTurns: extra.maxTurns ?? builder.maxTurns,
      timeoutMinutes: extra.timeoutMinutes ?? builder.timeoutMinutes,
    },
    ...extra,
  };
}

function sidecarExportUrlFromSyncUrl(value) {
  const sync = String(value ?? "").trim();
  if (!sync) return "";
  return sync.replace(/\/__sync\/?$/, "/__export");
}

function strictReceipt(value) {
  const receipt = dataOf(value);
  if (receipt?.ok !== true || receipt?.draft !== true || !receipt?.pullRequest) {
    throw new Error("dev/preview-promote did not return a draft pull request receipt");
  }
  return receipt;
}

// Ported verbatim from microservice-dev-session.js (SW 1.0 seed): the shell
// helpers and multi-service SEED_SHELL that materializes per-service
// .syncenv.d/<service> config, a UNION sparse checkout, activate-repo.sh, and
// sync.sh into /sandbox/work. Used ONLY on the multi-service path; a
// single-service run keeps the proven curl export/sync contract untouched.
function shq(value) {
  return "'" + String(value ?? '').split("'").join("'\\''") + "'"
}
function b64(text) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < text.length; i += 3) {
    const c1 = text.charCodeAt(i)
    const c2 = text.charCodeAt(i + 1)
    const c3 = text.charCodeAt(i + 2)
    out += chars[c1 >> 2]
    out += chars[((c1 & 3) << 4) | (Number.isNaN(c2) ? 0 : c2 >> 4)]
    out += Number.isNaN(c2) ? '=' : chars[((c2 & 15) << 2) | (Number.isNaN(c3) ? 0 : c3 >> 6)]
    out += Number.isNaN(c3) ? '=' : chars[c3 & 63]
  }
  return out
}
const SEED_SHELL = "\nset -eu\ncd /sandbox/work\nrm -rf repo .syncenv .syncenv.d .preview-services.json .preview-services-summary .sparse-paths .sparse-cones .sparse-cones.unsorted\nrm -f repo.tar repo.tar.sha256 activate-repo.sh sync.sh .syncdeps.* .repo-link.* .repo.tar.tmp.* .repo.tar.sha256.tmp.* .activate-repo.tmp.*\ncat > .gitignore <<'WFB_ROOT_GITIGNORE'\n/repo\n/repo.tar\n/repo.tar.sha256\n/activate-repo.sh\n/sync.sh\n/.syncenv\n/.syncenv.d\n/.preview-services.json\n/.preview-services-summary\n/.sparse-paths\n/.sparse-cones\n/.sparse-cones.unsorted\n/.syncdeps.*\n/.repo-link.*\n/.repo.tar.tmp.*\n/.repo.tar.sha256.tmp.*\n/.activate-repo.tmp.*\nWFB_ROOT_GITIGNORE\ntest \"$REPOURL\" = PittampalliOrg/workflow-builder || { echo 'repoUrl must be PittampalliOrg/workflow-builder' >&2; exit 2; }\ncase \"$MODE\" in host-throwaway|preview-native) ;; *) echo 'unsupported dev-preview mode' >&2; exit 2 ;; esac\nif [ \"$MODE\" = preview-native ]; then printf '%s' \"$SOURCE_REVISION\" | grep -Eq '^[0-9a-f]{40}$' || { echo 'preview-native requires a lowercase 40-hex sourceRevision' >&2; exit 2; }; fi\npython3 - <<'PY_PREVIEW_METADATA'\nimport base64\nimport binascii\nimport json\nimport os\nimport posixpath\nimport re\nimport shlex\nimport sys\nimport urllib.parse\nfrom pathlib import Path\n\nMAX_ENCODED_BYTES = 1024 * 1024\nMAX_DECODED_BYTES = 768 * 1024\nMAX_SERVICES = 32\nSAFE_SERVICE = re.compile(r\"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$\")\nSAFE_PATH = re.compile(r\"^[A-Za-z0-9._+-]+(?:/[A-Za-z0-9._+-]+)*$\")\nSAFE_HEALTH_PATH = re.compile(r\"^/(?:[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*)?$\")\n\n\ndef invalid():\n    raise ValueError(\"invalid preview metadata\")\n\n\ndef safe_text(value, *, allow_empty=False, limit=8192):\n    if not isinstance(value, str) or len(value) > limit:\n        invalid()\n    if not allow_empty and not value:\n        invalid()\n    if any(ord(char) < 32 or ord(char) == 127 for char in value):\n        invalid()\n    return value\n\n\ndef safe_path(value):\n    value = safe_text(value, limit=512)\n    if SAFE_PATH.fullmatch(value) is None:\n        invalid()\n    return value\n\n\ndef mappings(value):\n    if not isinstance(value, list) or len(value) > 128:\n        invalid()\n    result = []\n    for entry in value:\n        if not isinstance(entry, dict):\n            invalid()\n        result.append((safe_path(entry.get(\"from\")), safe_path(entry.get(\"to\"))))\n    return result\n\n\ndef repository_path(base, relative):\n    resolved = posixpath.normpath(posixpath.join(base, relative))\n    if (\n        not resolved\n        or resolved in (\".\", \"..\")\n        or resolved.startswith(\"../\")\n        or posixpath.isabs(resolved)\n    ):\n        invalid()\n    return resolved.removeprefix(\"./\")\n\n\ndef write_private(path, content):\n    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, \"O_NOFOLLOW\", 0)\n    fd = os.open(path, flags, 0o600)\n    with os.fdopen(fd, \"w\", encoding=\"utf-8\", newline=\"\\n\") as handle:\n        handle.write(content)\n    os.chmod(path, 0o600)\n\n\ntry:\n    encoded = os.environ.get(\"PREVIEWS_B64\", \"\")\n    if not encoded or len(encoded) > MAX_ENCODED_BYTES:\n        invalid()\n    decoded = base64.b64decode(encoded, validate=True)\n    if not decoded or len(decoded) > MAX_DECODED_BYTES:\n        invalid()\n    previews = json.loads(decoded.decode(\"utf-8\"))\n    if not isinstance(previews, list) or not 1 <= len(previews) <= MAX_SERVICES:\n        invalid()\n\n    seen = set()\n    services = []\n    sparse_paths = {\"scripts/dev-sync/sync.sh\"}\n    sync_files = []\n    for entry in previews:\n        if not isinstance(entry, dict) or entry.get(\"ok\") is not True:\n            invalid()\n        service = entry.get(\"service\")\n        if not isinstance(service, str) or SAFE_SERVICE.fullmatch(service) is None:\n            invalid()\n        if service in seen:\n            invalid()\n        seen.add(service)\n\n        info = entry.get(\"info\")\n        if not isinstance(info, dict) or info.get(\"ready\") is not True:\n            invalid()\n        repo_subdir = safe_path(info.get(\"repoSubdir\", \".\"))\n        sync_paths = info.get(\"syncPaths\", [\"src\"])\n        if not isinstance(sync_paths, list) or not 1 <= len(sync_paths) <= 128:\n            invalid()\n        sync_paths = [safe_path(path) for path in sync_paths]\n        sync_url = safe_text(info.get(\"syncUrl\"), limit=2048)\n        if re.fullmatch(r\"https?://[^\\s]+\", sync_url) is None:\n            invalid()\n        service_url = safe_text(info.get(\"url\"), limit=2048)\n        parsed_url = urllib.parse.urlsplit(service_url)\n        try:\n            service_port = parsed_url.port\n        except ValueError:\n            invalid()\n        if (\n            parsed_url.scheme not in (\"http\", \"https\")\n            or not parsed_url.hostname\n            or parsed_url.username is not None\n            or parsed_url.password is not None\n            or service_port is None\n            or parsed_url.path not in (\"\", \"/\")\n            or parsed_url.query\n            or parsed_url.fragment\n        ):\n            invalid()\n        health_path = safe_text(info.get(\"healthPath\"), limit=512)\n        if (\n            SAFE_HEALTH_PATH.fullmatch(health_path) is None\n            or posixpath.normpath(health_path) != health_path\n        ):\n            invalid()\n        health_url = service_url.rstrip(\"/\") + health_path\n        sync_token = safe_text(info.get(\"syncCapability\"), limit=16384)\n        extra_sync = mappings(info.get(\"extraSync\", []))\n        capture_only = mappings(info.get(\"captureOnly\", []))\n        combined_mappings = extra_sync + capture_only\n\n        for path in sync_paths:\n            sparse_paths.add(repository_path(repo_subdir, path))\n        for source, _target in combined_mappings:\n            sparse_paths.add(repository_path(repo_subdir, source))\n\n        env_values = {\n            \"SERVICE\": service,\n            \"SUBDIR\": repo_subdir,\n            \"PATHS\": \" \".join(sync_paths),\n            \"SYNCURL\": sync_url,\n            \"HEALTHURL\": health_url,\n            \"SYNC_TOKEN\": sync_token,\n            \"EXTRASYNC\": \" \".join(\n                f\"{source}:{target}\" for source, target in combined_mappings\n            ),\n        }\n        sync_files.append(\n            (\n                service,\n                \"\".join(\n                    f\"{key}={shlex.quote(value)}\\n\"\n                    for key, value in env_values.items()\n                ),\n            )\n        )\n        services.append(service)\n\n    sync_dir = Path(\".syncenv.d\")\n    sync_dir.mkdir(mode=0o700)\n    os.chmod(sync_dir, 0o700)\n    write_private(\n        \".preview-services.json\",\n        json.dumps(previews, ensure_ascii=True, separators=(\",\", \":\")) + \"\\n\",\n    )\n    write_private(\".sparse-paths\", \"\".join(f\"{path}\\n\" for path in sorted(sparse_paths)))\n    for service, content in sync_files:\n        write_private(sync_dir / service, content)\n    write_private(\".preview-services-summary\", \",\".join(services) + \"\\n\")\nexcept (binascii.Error, OSError, TypeError, UnicodeError, ValueError):\n    print(\"failed to materialize trusted preview service metadata\", file=sys.stderr)\n    raise SystemExit(4)\nPY_PREVIEW_METADATA\ntest -s .sparse-paths || { echo 'preview source metadata produced no checkout paths' >&2; exit 4; }\nLOCAL_ROOT=$(mktemp -d /tmp/wfb-preview-checkout.XXXXXX)\nSHARED_ARCHIVE_TMP=/sandbox/work/.repo.tar.tmp.$$\nSHARED_DIGEST_TMP=/sandbox/work/.repo.tar.sha256.tmp.$$\nSHARED_ACTIVATOR_TMP=/sandbox/work/.activate-repo.tmp.$$\ntrap 'rm -rf \"$LOCAL_ROOT\"; rm -f \"$SHARED_ARCHIVE_TMP\" \"$SHARED_DIGEST_TMP\" \"$SHARED_ACTIVATOR_TMP\"' EXIT HUP INT TERM\nCLONE_URL=\"https://github.com/$REPOURL.git\"\nexport GIT_TERMINAL_PROMPT=0\nif [ -n \"${GITHUB_TOKEN:-}\" ]; then\n  GIT_ASKPASS=\"$LOCAL_ROOT/git-askpass\"\n  printf '%s\\n' '#!/bin/sh' 'case \"$1\" in' '  *Username*) printf \"%s\\n\" x-access-token ;;' '  *Password*) printf \"%s\\n\" \"$GITHUB_TOKEN\" ;;' '  *) exit 1 ;;' 'esac' > \"$GIT_ASKPASS\"\n  chmod 700 \"$GIT_ASKPASS\"\n  export GIT_ASKPASS\nfi\nLOCAL_REPO=\"$LOCAL_ROOT/repo\"\ngit clone --filter=blob:none --no-checkout --depth 1 --single-branch \"$CLONE_URL\" \"$LOCAL_REPO\"\nif [ -n \"${GITHUB_TOKEN:-}\" ]; then\n  git -C \"$LOCAL_REPO\" config credential.username x-access-token\n  git -C \"$LOCAL_REPO\" config credential.helper '!f() { test -n \"$GITHUB_TOKEN\" || exit 1; printf \"%s\\n\" \"password=$GITHUB_TOKEN\"; }; f'\nfi\nif [ -n \"$SOURCE_REVISION\" ]; then\n  printf '%s' \"$SOURCE_REVISION\" | grep -Eq '^[0-9a-f]{40}$' || { echo 'sourceRevision must be a lowercase 40-hex Git SHA' >&2; exit 2; }\n  git -C \"$LOCAL_REPO\" fetch --no-tags --depth 1 origin \"$SOURCE_REVISION\"\n  TARGET_REVISION=\"$SOURCE_REVISION\"\nelse\n  TARGET_REVISION=$(git -C \"$LOCAL_REPO\" rev-parse HEAD)\nfi\n: > .sparse-cones.unsorted\nwhile IFS= read -r path; do\n  TREE_ENTRY=$(git -C \"$LOCAL_REPO\" ls-tree \"$TARGET_REVISION\" -- \"$path\") || { echo 'failed to inspect preview source path at target revision' >&2; exit 4; }\n  SOURCE_TYPE=$(printf '%s\\n' \"$TREE_ENTRY\" | awk 'NR == 1 { print $2 }')\n  case \"$SOURCE_TYPE\" in\n    tree) printf '%s\\n' \"$path\" >> .sparse-cones.unsorted ;;\n    blob)\n      case \"$path\" in\n        */*) printf '%s\\n' \"${path%/*}\" >> .sparse-cones.unsorted ;;\n      esac\n      ;;\n    \"\") printf '%s\\n' \"$path\" >> .sparse-cones.unsorted ;;\n    *) echo 'preview source metadata resolved to an unsupported Git object' >&2; exit 4 ;;\n  esac\ndone < .sparse-paths\nsort -u .sparse-cones.unsorted > .sparse-cones\ngit -C \"$LOCAL_REPO\" sparse-checkout init --cone\ngit -C \"$LOCAL_REPO\" sparse-checkout set --stdin < .sparse-cones\ngit -C \"$LOCAL_REPO\" checkout --detach \"$TARGET_REVISION\"\nACTUAL_REVISION=$(git -C \"$LOCAL_REPO\" rev-parse HEAD)\nif [ -n \"$SOURCE_REVISION\" ]; then test \"$ACTUAL_REVISION\" = \"$SOURCE_REVISION\" || { echo 'checked-out revision does not match sourceRevision' >&2; exit 3; }; fi\ngit -C \"$LOCAL_REPO\" remote set-url origin \"$CLONE_URL\"\ntest -z \"$(git -C \"$LOCAL_REPO\" status --porcelain --untracked-files=all)\" || { echo 'local preview checkout is not clean' >&2; exit 3; }\nprintf '%s\\n' \"$ACTUAL_REVISION\" > \"$LOCAL_REPO/.git/wfb-preview-source-revision\"\nchmod 600 \"$LOCAL_REPO/.git/wfb-preview-source-revision\"\ntar -C \"$LOCAL_REPO\" -cf \"$LOCAL_ROOT/repo.tar\" .\nARCHIVE_DIGEST=$(sha256sum \"$LOCAL_ROOT/repo.tar\")\nARCHIVE_DIGEST=${ARCHIVE_DIGEST%% *}\nprintf '%s' \"$ARCHIVE_DIGEST\" | grep -Eq '^[0-9a-f]{64}$' || { echo 'failed to hash preview source archive' >&2; exit 3; }\ncp \"$LOCAL_ROOT/repo.tar\" \"$SHARED_ARCHIVE_TMP\"\nchmod 600 \"$SHARED_ARCHIVE_TMP\"\nmv -f \"$SHARED_ARCHIVE_TMP\" /sandbox/work/repo.tar\nprintf '%s  repo.tar\\n' \"$ARCHIVE_DIGEST\" > \"$SHARED_DIGEST_TMP\"\nchmod 600 \"$SHARED_DIGEST_TMP\"\nmv -f \"$SHARED_DIGEST_TMP\" /sandbox/work/repo.tar.sha256\n{\n  printf '%s\\n' '#!/bin/sh' \"EXPECTED_DIGEST=$ARCHIVE_DIGEST\" \"EXPECTED_REVISION=$ACTUAL_REVISION\"\n  cat <<'ACTIVATE_REPO'\nset -eu\nWORKSPACE=/sandbox/work\nLOCAL_REPO=/tmp/wfb-dev-repo\nARCHIVE=\"$WORKSPACE/repo.tar\"\nDIGEST_FILE=\"$WORKSPACE/repo.tar.sha256\"\nREPO_LINK=\"$WORKSPACE/repo\"\nREPO_STAGING=\nLOCAL_ARCHIVE=\nLINK_STAGING=\"$WORKSPACE/.repo-link.$$\"\n\nfail() {\n  echo \"preview repository activation failed\" >&2\n  exit 6\n}\n\ncleanup() {\n  [ -z \"$REPO_STAGING\" ] || rm -rf \"$REPO_STAGING\"\n  [ -z \"$LOCAL_ARCHIVE\" ] || rm -f \"$LOCAL_ARCHIVE\"\n  rm -f \"$LINK_STAGING\"\n}\ntrap cleanup EXIT HUP INT TERM\n\ncase \"$WORKSPACE\" in /*) ;; *) fail ;; esac\ncase \"$LOCAL_REPO\" in /tmp/*) ;; *) fail ;; esac\nprintf '%s' \"$EXPECTED_DIGEST\" | grep -Eq '^[0-9a-f]{64}$' || fail\nprintf '%s' \"$EXPECTED_REVISION\" | grep -Eq '^[0-9a-f]{40}$' || fail\n[ ! -L \"$LOCAL_REPO\" ] || fail\n\nlink_repo() {\n  if [ -e \"$REPO_LINK\" ] && [ ! -L \"$REPO_LINK\" ]; then fail; fi\n  rm -f \"$LINK_STAGING\"\n  ln -s \"$LOCAL_REPO\" \"$LINK_STAGING\"\n  mv -Tf \"$LINK_STAGING\" \"$REPO_LINK\"\n}\n\nif [ -d \"$LOCAL_REPO/.git\" ] && [ -f \"$LOCAL_REPO/.git/wfb-preview-archive-sha256\" ]; then\n  IFS= read -r ACTIVE_DIGEST < \"$LOCAL_REPO/.git/wfb-preview-archive-sha256\" || fail\n  IFS= read -r SOURCE_REVISION < \"$LOCAL_REPO/.git/wfb-preview-source-revision\" || fail\n  ACTIVE_REVISION=$(git -C \"$LOCAL_REPO\" rev-parse HEAD) || fail\n  test \"$ACTIVE_DIGEST\" = \"$EXPECTED_DIGEST\" || fail\n  test \"$SOURCE_REVISION\" = \"$EXPECTED_REVISION\" || fail\n  test \"$ACTIVE_REVISION\" = \"$EXPECTED_REVISION\" || fail\n  link_repo\n  echo REUSED \"$ACTIVE_REVISION\"\n  exit 0\nfi\n\nif [ -e \"$LOCAL_REPO\" ] || [ -L \"$LOCAL_REPO\" ]; then fail; fi\ntest -f \"$ARCHIVE\" && test ! -L \"$ARCHIVE\" || fail\ntest -f \"$DIGEST_FILE\" && test ! -L \"$DIGEST_FILE\" || fail\nIFS= read -r DIGEST_RECORD < \"$DIGEST_FILE\" || fail\ntest \"$DIGEST_RECORD\" = \"$EXPECTED_DIGEST  repo.tar\" || fail\nREPO_STAGING=$(mktemp -d /tmp/wfb-dev-repo.activate.XXXXXX) || fail\nchmod 700 \"$REPO_STAGING\"\nLOCAL_ARCHIVE=$(mktemp /tmp/wfb-dev-repo.archive.XXXXXX) || fail\nchmod 600 \"$LOCAL_ARCHIVE\"\ncp \"$ARCHIVE\" \"$LOCAL_ARCHIVE\" || fail\nACTUAL_DIGEST=$(sha256sum \"$LOCAL_ARCHIVE\") || fail\nACTUAL_DIGEST=${ACTUAL_DIGEST%% *}\ntest \"$ACTUAL_DIGEST\" = \"$EXPECTED_DIGEST\" || fail\n\ntar -C \"$REPO_STAGING\" -xf \"$LOCAL_ARCHIVE\"\ntest -d \"$REPO_STAGING/.git\" || fail\nIFS= read -r SOURCE_REVISION < \"$REPO_STAGING/.git/wfb-preview-source-revision\" || fail\nprintf '%s' \"$SOURCE_REVISION\" | grep -Eq '^[0-9a-f]{40}$' || fail\ntest \"$SOURCE_REVISION\" = \"$EXPECTED_REVISION\" || fail\nACTIVE_REVISION=$(git -C \"$REPO_STAGING\" rev-parse HEAD) || fail\ntest \"$ACTIVE_REVISION\" = \"$EXPECTED_REVISION\" || fail\ntest -z \"$(git -C \"$REPO_STAGING\" status --porcelain --untracked-files=all)\" || fail\nprintf '%s\\n' \"$EXPECTED_DIGEST\" > \"$REPO_STAGING/.git/wfb-preview-archive-sha256\"\nchmod 600 \"$REPO_STAGING/.git/wfb-preview-archive-sha256\"\nmv \"$REPO_STAGING\" \"$LOCAL_REPO\"\nlink_repo\necho ACTIVATED \"$ACTIVE_REVISION\"\nACTIVATE_REPO\n} > \"$SHARED_ACTIVATOR_TMP\"\nchmod 700 \"$SHARED_ACTIVATOR_TMP\"\nmv -f \"$SHARED_ACTIVATOR_TMP\" /sandbox/work/activate-repo.sh\ncp \"$LOCAL_REPO/scripts/dev-sync/sync.sh\" /sandbox/work/sync.sh\nchmod 700 /sandbox/work/sync.sh\nIFS= read -r SERVICES_SUMMARY < .preview-services-summary\necho ARCHIVED \"$ACTUAL_REVISION\"\necho SERVICES \"$SERVICES_SUMMARY\"\n"

const t = args ?? {};
const intent = typeof t.intent === "string" ? t.intent.trim() : "";
if (!intent) throw new Error("intent is required");

const service = typeof t.service === "string" && t.service ? t.service : DEFAULT_SERVICE;
const services = asStringArray(t.services, [service]);
// Multi-service is opt-in via the number of requested services. A single
// service keeps the proven curl export/sync contract byte-for-byte; more than
// one seeds every service's sync config into the workspace and drives one
// shared sync.sh generation. The server gate (PREVIEW_DEV_MULTISERVICE) is the
// authority for whether >1 service is ever dispatched here.
const multiService = services.length > 1;
const routes = t.targetRoutes == null ? DEFAULT_ROUTES : t.targetRoutes;
if (
  !Array.isArray(routes) ||
  routes.length < 1 ||
  routes.length > 16 ||
  new Set(routes).size !== routes.length ||
  !routes.every(
    (route) =>
      typeof route === "string" &&
      /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/.test(route),
  )
) {
  throw new Error("targetRoutes must contain unique absolute application routes");
}
const maxIterations = Math.max(1, Math.min(3, Number(t.maxIterations ?? 2) || 2));
const builderProfile =
  typeof t.builderProfile === "string" && t.builderProfile.length > 0
    ? t.builderProfile
    : DEFAULT_BUILDER_PROFILE;
const builder = BUILDER_PROFILES[builderProfile];
if (!builder) throw new Error("builderProfile is not supported");
const agentSlug = builder.agentSlug;
const agentType = builder.agentType;
const pydanticUiProfile = builderProfile === "pydantic-ai-k3-ui";

function asBoolean(value) {
  return value === true || String(value).trim().toLowerCase() === "true";
}
const retainAfterCompletion = asBoolean(t.retainAfterCompletion);
const interactiveHandoff = asBoolean(t.interactiveHandoff);
// Phase 3 impact-review gates. They require the multi-service seeded workspace
// (per-service .syncenv.d, a git checkout at /sandbox/work/repo, sync.log), so
// they only run on the multi-service path. diffScope enforcement additionally
// engages when an explicit diffScope allowlist is supplied. With impactReview
// off (the default) NOT ONE new node runs — single- and multi-service behavior
// is byte-for-byte unchanged.
const impactReview = asBoolean(t.impactReview);
const diffScopeInput = asStringArray(t.diffScope, null);
const runGates = impactReview && multiService;
const enforceDiffScope = multiService && (impactReview || (diffScopeInput != null && diffScopeInput.length > 0));
// Platform sandbox lifetime ceiling: sandbox-execution-api DevPreviewRequest
// validates timeoutSeconds with le=86400 (services/sandbox-execution-api/src/app.py),
// so one provision can never outlive 24h. Clamp (never throw) so a bad ttlHours
// cannot fail a run that today's inputs would have started.
const MAX_SANDBOX_TIMEOUT_SECONDS = 86400;
const ttlHours = Number.isInteger(t.ttlHours) ? t.ttlHours : 24;
const sandboxTimeoutSeconds = retainAfterCompletion
  ? Math.max(3600, Math.min(ttlHours * 3600, MAX_SANDBOX_TIMEOUT_SECONDS))
  : 86400;

phase("Dev mode");
const preview = await action(
  "dev/preview",
  {
    service,
    services,
    mode: "preview-native",
    adopt: true,
    timeoutSeconds: sandboxTimeoutSeconds,
    waitReadySeconds: 240,
    activationTimeoutSeconds: 300,
    activationPollSeconds: 2,
    activationMaxAttempts: 151,
  },
  { label: "enter existing preview live-sync mode" },
);
const previewFailure = failureOf(dataOf(preview));
if (previewFailure) throw new Error(`dev/preview: ${previewFailure}`);

const info = serviceInfo(preview, service);
const previewUrl = String(info.url ?? dataOf(preview).url ?? dataOf(preview).browseUrl ?? "");
// Single-service path (default): the proven primary-tuple curl export/sync
// contract, unchanged. Multi-service path: seed every requested service's sync
// config into /sandbox/work and let the agent drive one shared sync.sh
// generation. The two paths share only the primary previewUrl (browse/smoke).
let syncUrl = "";
let syncCapability = "";
let exportUrl = "";
if (!multiService) {
  syncUrl = String(info.syncUrl ?? "");
  syncCapability = String(info.syncCapability ?? "");
  if (!previewUrl || !syncUrl || !syncCapability) {
    throw new Error("preview live-sync metadata is incomplete");
  }
  exportUrl = sidecarExportUrlFromSyncUrl(syncUrl);
  if (!exportUrl || exportUrl === syncUrl) {
    throw new Error("preview live-sync sidecar export endpoint is incomplete");
  }
} else {
  if (!previewUrl) {
    throw new Error("preview live-sync metadata is incomplete");
  }
  // Materialize per-service sync config (.syncenv.d/<service>), a UNION sparse
  // checkout, activate-repo.sh, and sync.sh into the shared workspace. Mirrors
  // microservice-dev-session's Provision->Seed handoff exactly; the seed with a
  // single service is behaviorally the same tuple the single-service path uses.
  const previews = Array.isArray(dataOf(preview).services)
    ? dataOf(preview).services
    : [{ service, ok: dataOf(preview).ready ?? false, info }];
  const previewsB64 = b64(JSON.stringify(previews));
  const exportsLine = [
    `export REPOURL=${shq("PittampalliOrg/workflow-builder")}`,
    `export SOURCE_REVISION=${shq(
      typeof t.sourceRevision === "string" ? t.sourceRevision : "",
    )}`,
    `export MODE=${shq("preview-native")}`,
    `export PREVIEWS_B64=${shq(previewsB64)}`,
  ].join("; ");
  const seed = await action(
    "workspace/command",
    {
      cliWorkspace: true,
      workspaceRef: workspace,
      command: exportsLine + ";" + SEED_SHELL,
      cwd: "/sandbox/work",
      timeoutMs: 1500000,
      helperPod: true,
      helperTimeoutMinutes: 120,
    },
    { label: "seed multi-service preview workspace" },
  );
  const seedFailure = failureOf(dataOf(seed));
  if (seedFailure) throw new Error(`workspace/command (seed): ${seedFailure}`);
}

// Scope authority comes from each selected receiver's authenticated, durable
// status receipt. Never inspect /sandbox/work/repo here: helper pods activate a
// separate pod-local checkout and therefore cannot see the generator pod's tree.
const scopeReceivers = enforceDiffScope ? diffScopeReceivers(preview, services) : [];

// diffScope allowlist. Explicit input wins; otherwise derive the default from
// each service's synced source roots (repoSubdir + syncPaths) — the machine-
// enforceable form of the contract's target paths. Generated build artifacts are
// always excluded (below), independent of this allowlist.
const diffScopeAllow = [];
if (diffScopeInput != null && diffScopeInput.length > 0) {
  for (const p of diffScopeInput) if (typeof p === "string" && p) diffScopeAllow.push(p);
} else {
  const previewServices = Array.isArray(dataOf(preview).services)
    ? dataOf(preview).services
    : [{ service, info }];
  for (const entry of previewServices) {
    const einfo = dataOf(entry?.info ?? entry ?? {});
    const subdir =
      typeof einfo.repoSubdir === "string" && einfo.repoSubdir ? einfo.repoSubdir : ".";
    const base = subdir === "." ? "" : subdir.replace(/\/+$/, "") + "/";
    const syncPaths =
      Array.isArray(einfo.syncPaths) && einfo.syncPaths.length ? einfo.syncPaths : ["src"];
    for (const sp of syncPaths) {
      if (typeof sp === "string" && sp) diffScopeAllow.push(base + sp.replace(/^\/+/, ""));
    }
  }
}

const fallbackContract = pydanticUiProfile
  ? {
      objective: intent,
      targetRoutes: routes,
      acceptanceCriteria: [
        {
          id: "requested-experience",
          description:
            "The requested UI is complete, interactive where appropriate, and visibly integrated with the existing Workflow Builder shell and theme.",
          verify: "Load every target route and exercise its primary developer workflow.",
        },
        {
          id: "real-data-or-empty-state",
          description:
            "Operational views use existing data contracts where available and provide honest loading, empty, degraded, and error states.",
          verify:
            "Inspect data loading and render each state without fabricated metrics or route failures.",
        },
        {
          id: "responsive-accessible-polish",
          description:
            "The experience is cohesive in light and dark themes, responsive on desktop and mobile, keyboard accessible, and reduced-motion aware.",
          verify:
            "Inspect the implemented components and exercise the target routes at representative viewport sizes.",
        },
        {
          id: "hmr-reflected",
          description:
            "The accepted source is applied through one or more atomic preview live-sync generations and served by the adopted HMR app.",
          verify:
            "Verify the latest receiver generation and smoke every target route before source capture.",
        },
        {
          id: "focused-diff",
          description:
            "The source diff is scoped to the requested UI and narrowly necessary supporting code; auth/sign-in code is untouched.",
          verify: "Inspect captured source and generated PR diff.",
        },
      ],
      dataSources: [
        "existing Workflow Builder application ports, route loaders, internal APIs, and explicit graceful empty states",
      ],
      diffScope:
        "requested Workflow Builder UI and narrowly necessary components, application ports, adapters, and routes",
      hmrVerification:
        "apply fresh atomic dev-sync generations, verify receiver health, and smoke all target routes",
    }
  : {
      objective: intent,
      targetRoutes: routes,
      acceptanceCriteria: [
        {
          id: "visible-dashboard-enhancement",
          description: "The dashboard visibly includes useful new functionality for understanding preview development activity.",
          verify: "Load the dashboard route and confirm the new section or controls are present.",
        },
        {
          id: "real-data-or-empty-state",
          description: "The UI uses existing application data where available and otherwise renders an explicit graceful empty state.",
          verify: "Inspect the implementation and dashboard response for guarded data sources and non-crashing empty states.",
        },
        {
          id: "hmr-reflected",
          description: "The change is pushed through the preview live-sync sidecar and reflected by the HMR-served preview app.",
          verify: "Export the sidecar source after sync and smoke the live dashboard route.",
        },
        {
          id: "focused-diff",
          description: "The source diff is scoped to dashboard UI and required supporting code; auth/sign-in code is untouched.",
          verify: "Inspect captured source and generated PR diff.",
        },
      ],
      dataSources: ["existing workflow-builder dashboard, run, session, and preview-environment APIs where available"],
      diffScope: "workflow-builder dashboard source and narrowly necessary supporting application/adapter code",
      hmrVerification: "sync via the dev-sync sidecar, export the synced source generation, then smoke the dashboard route",
    };
const fallbackContractText = JSON.stringify(fallbackContract, null, 2);

phase("Plan");
const plan = fallbackContract;

// A multi-service generation edits + syncs every requested service in one pass,
// so give the agent more turns and time (bounded). A single-service run keeps
// the proven {24 turns, 35 min} budget byte-for-byte.
const generatorBudget = pydanticUiProfile
  ? { maxTurns: builder.maxTurns, timeoutMinutes: builder.timeoutMinutes }
  : multiService
    ? {
        maxTurns: Math.min(24 * services.length, 96),
        timeoutMinutes: Math.min(35 + 10 * (services.length - 1), 90),
      }
    : { maxTurns: 24, timeoutMinutes: 35 };

phase("Generate");
let accepted = false;
let iterations = 0;
let lastVerdict = null;
let lastGenerator = null;
let acceptedCapture = null;
let lastGateSummary = null;
let lastDiffScope = null;

while (!accepted && iterations < maxIterations) {
  let iterationGeneration = null;
  const feedback = lastVerdict
    ? `\nPrevious verifier feedback to address:\n${JSON.stringify(lastVerdict)}\n`
    : "";
  const generatorPrompt = pydanticUiProfile
    ? multiService
      ? `You are the Pydantic AI Kimi K3 builder for a Workflow Builder MULTI-SERVICE preview development run.

The isolated system is already running and its receiver-owned source is seeded into /sandbox/work. Implement the user task across these services: ${services.join(", ")}.

ACTIVATION:
- Run /sandbox/work/activate-repo.sh and confirm it reports ACTIVATED or REUSED, then work in /sandbox/work/repo.
- Inspect the relevant app shell, navigation, design tokens, shared UI primitives, target routes, and neighboring operational surfaces before choosing the implementation.

QUALITY BUILD MODE:
- Treat the task's product and system contract as authoritative. Inspect no more than eight repository files before the first source write.
- Build a complete thin vertical slice first: target route, navigation, first viewport, primary interaction, and honest unavailable states. Apply and verify it by model iteration 25.
- This is a hard ordering constraint. Do not inspect database schemas, workflow internals, secondary adapters, tests, or optional APIs until the first receiver-owned HMR generation is healthy.
- Build the complete requested experience, including real-data integration or honest empty/degraded states, responsive layouts, keyboard and screen-reader behavior, light/dark theme cohesion, and reduced-motion handling.
- Preserve the repository's hexagonal boundaries and existing Svelte, Tailwind, shadcn, and Lucide conventions. Do not invent a parallel visual system or fake operational metrics.
- You may inspect every relevant source file and apply multiple atomic HMR generations when that materially improves correctness or polish. Keep each generation coherent and use a fresh generation identifier.
- After every intentional generation, run exactly \`/sandbox/work/sync.sh > /sandbox/work/sync.log 2>&1\` once. Read the persistent log and require an \`APPLIED ...\` receipt for every selected service plus \`SYNCED generation=... services=${services.length} convergence=healthy\`.
- Smoke ${routes.join(", ")} against ${previewUrl} after the final generation and fix HTTP 500, ReferenceError, or each_key_duplicate failures before stopping.

Hard rules:
- Edit only receiver-owned source in /sandbox/work/repo. Never use Kubernetes, GitHub, broker, host, or provider credentials.
- Do not commit or push. dev/preview-snapshot and dev/preview-promote exclusively own capture and draft-PR creation.
- Never touch auth/sign-in code.
- Use this contract as the source of truth:
${fallbackContractText}

User task:
${intent}
${feedback}`
      : `You are the Pydantic AI Kimi K3 builder for a Workflow Builder preview UI-development run.

The live application is already running with Vite HMR. Build the complete requested UI experience against receiver-owned source and leave the final accepted generation healthy at ${previewUrl}.

QUALITY BUILD MODE:
- Treat the task's product and system contract as authoritative. After pulling source, inspect no more than eight repository files: the target route or closest operational page, navigation, app shell, design tokens, and one relevant shared component.
- Build a complete thin vertical slice first: target route, navigation, first viewport, primary interaction, and honest unavailable states. Apply and verify it by model iteration 25.
- This is a hard ordering constraint. Do not inspect database schemas, workflow internals, secondary adapters, tests, or optional APIs until the first receiver-owned HMR generation is healthy.
- Integrate with the current Svelte 5, Tailwind, shadcn, Lucide, typography, spacing, light/dark theme, and motion conventions. Aim for high information clarity and visual polish without turning an operational surface into a marketing page.
- Use real existing APIs and application ports where available. Show explicit loading, empty, degraded, and error states instead of fabricated data.
- Preserve hexagonal architecture, responsive behavior, semantic HTML, keyboard access, visible focus, and reduced-motion support.
- You may apply multiple atomic HMR generations while iterating. Every sync must use a fresh generation identifier and coherent receiver-owned source bytes. Finish only after the latest generation serves all target routes cleanly.

Hard rules:
- Edit only receiver-owned source pulled from ${exportUrl}; never use Kubernetes, GitHub, broker, host, or provider credentials.
- Keep the diff focused on the requested UI and narrowly necessary components, application ports, adapters, and routes.
- Do not commit or push. dev/preview-snapshot and dev/preview-promote exclusively own capture and draft-PR creation.
- Never touch auth/sign-in code.
- Use this contract as the source of truth:
${fallbackContractText}

Required workflow:
1. Pull source:
   SCRATCH=/sandbox/work/preview-ui-gan-build; rm -rf "$SCRATCH"; mkdir -p "$SCRATCH/repo"; curl -sS -H "x-sync-token: ${syncCapability}" -D "$SCRATCH/export.headers" "${exportUrl}" -o "$SCRATCH/source.tgz"; ROOTS_JSON="$(sed -n 's/^x-sync-roots:[[:space:]]*//p' "$SCRATCH/export.headers" | tr -d '\\r' | tail -1)"; test -n "$ROOTS_JSON"; tar -xzf "$SCRATCH/source.tgz" -C "$SCRATCH/repo".
2. Implement the thin vertical slice under "$SCRATCH/repo" after inspecting no more than eight repository files, then proceed directly to step 3. Broaden the data boundary and run focused checks only after the first healthy sync.
3. Push an atomic HMR generation after each coherent iteration:
   cd "$SCRATCH/repo" && GEN="$(cat /proc/sys/kernel/random/uuid)" && node -e 'const roots=JSON.parse(process.argv[1]); if (!Array.isArray(roots) || roots.length === 0) process.exit(2); for (const root of roots) console.log(root);' "$ROOTS_JSON" > "$SCRATCH/declared-roots" && : > "$SCRATCH/existing-roots" && while IFS= read -r p; do [ ! -e "$p" ] || printf '%s\\n' "$p" >> "$SCRATCH/existing-roots"; done < "$SCRATCH/declared-roots" && tar -czf "$SCRATCH/sync.tgz" -T "$SCRATCH/existing-roots" && curl -sS -X POST --data-binary @"$SCRATCH/sync.tgz" -H 'content-type: application/gzip' -H "x-sync-token: ${syncCapability}" -H "x-sync-generation: $GEN" -H "x-sync-service: ${service}" -H "x-sync-roots: $ROOTS_JSON" "${syncUrl}" | tee /sandbox/work/preview-ui-gan-sync-${iterations + 1}.json.
4. Poll ${previewUrl}/api/health until HTTP 200, then request every target route (${routes.join(", ")}). Fix HTTP 500, ReferenceError, and each_key_duplicate failures. Repeat steps 2-4 with a new generation when necessary.
5. Stop only when the latest live generation satisfies the contract; summarize the implementation and verification without committing or pushing.

User task:
${intent}
${feedback}`
    : multiService
      ? `You are the Kimi K3 builder for a workflow-builder MULTI-SERVICE preview development run.

You are running inside the preview workflow with a shared JuiceFS workspace. The isolated multi-service system is already running and its source is seeded into /sandbox/work. Implement the requested change across these services and push exactly one shared live-sync generation before stopping: ${services.join(", ")}.

ACTIVATION (do this first, once):
- Run /sandbox/work/activate-repo.sh and confirm it reports ACTIVATED or REUSED, then cd /sandbox/work/repo.
- The per-service sync config is in /sandbox/work/.syncenv.d/ (one file per service). The shared sync client is /sandbox/work/sync.sh.

TIGHT BUILD MODE:
- Do not perform broad repository exploration. Inspect only the files you must edit.
- Prefer additive, focused changes over architectural rewrites.
- Use real existing data or explicit graceful empty states. Do not invent fake metrics.
- If a workflow-builder dashboard change is in scope, leave the literal text "${DASHBOARD_MARKER}" in the rendered dashboard source (src/routes/dashboard/+page.svelte).
- Do not create standalone contract/proof files as the implementation. The useful source edit is the deliverable.

SYNC CONTRACT (this is how the live system is updated):
- After completing ONE logical edit generation, run exactly \`/sandbox/work/sync.sh > /sandbox/work/sync.log 2>&1\` once. It pushes that single generation to EVERY selected service (including unchanged ones) and hot-reloads them.
- Then inspect /sandbox/work/sync.log and verify an \`APPLIED ...\` receipt for EVERY selected service AND the final global \`SYNCED generation=... services=${services.length} convergence=healthy\` line before claiming the live system was updated.
- Never re-run sync merely to recover truncated tool output; read the persistent log instead. Re-run only after the log proves a real failure you have diagnosed, or after further edits intentionally create a new generation.

Hard rules:
- Edit only receiver-owned source in /sandbox/work/repo; never use Kubernetes, GitHub, root broker, host credentials, or raw preview authority.
- Preserve hexagonal architecture. Do not put database or external HTTP details into domain/application code.
- Do not commit or push. Source capture and PR creation are handled by dev/preview-snapshot and dev/preview-promote after verification.
- Never touch auth/sign-in code.
- Use this contract as the source of truth:
${fallbackContractText}

Smoke the live app after the shared sync: poll ${previewUrl}/api/health until HTTP 200, then request ${routes.join(", ")} and verify the route does not return HTTP 500 and the served HTML has no ReferenceError or each_key_duplicate. Exercise cross-service behavior, not only a standalone health route.

User task:
${intent}
${feedback}`
      : `You are the Kimi K3 builder for a workflow-builder preview UI-development run.

You are running inside the preview workflow with a shared JuiceFS workspace. Implement the requested dashboard enhancement against the live preview and push exactly one HMR generation before stopping.

TIGHT BUILD MODE:
- Do not perform broad repository exploration.
- Inspect at most five source files before editing.
- Prefer an additive dashboard enhancement over architectural rewrites.
- If existing preview/session/workflow data is not already available to the dashboard, render a useful empty state instead of adding new data plumbing.
- The proof target is a "Preview Development Status" dashboard panel or equivalent dashboard section that helps a user understand preview environments, live-sync/HMR state, recent workflow/session activity, and PR capture status when data is available.
- Target the existing dashboard file first: src/routes/dashboard/+page.svelte. Only inspect or edit src/routes/api/v1/dashboard/+server.ts if the existing dashboard API is already enough to reuse safely.
- A passing implementation must leave the literal text "${DASHBOARD_MARKER}" in the rendered dashboard source.
- Do not create standalone contract/proof files as the implementation. The useful dashboard source edit is the deliverable.
- After the one HMR sync and smoke check, stop and summarize. Do not continue polishing.

Hard rules:
- Edit only receiver-owned source pulled from the dev-sync sidecar export endpoint ${exportUrl}; never use Kubernetes, GitHub, root broker, host credentials, or raw preview authority.
- Keep changes focused on workflow-builder dashboard functionality and necessary supporting components/ports/adapters.
- Preserve hexagonal architecture. Do not put database or external HTTP details into domain/application code.
- Use real existing data or explicit graceful empty states. Do not invent fake metrics.
- Do not commit or push. Source capture and PR creation are handled by dev/preview-snapshot and dev/preview-promote after verification.
- Never touch auth/sign-in code.
- Use this contract as the source of truth:
${fallbackContractText}

Required implementation steps:
1. Pull source:
   SCRATCH=/tmp/preview-ui-gan-build; rm -rf "$SCRATCH"; mkdir -p "$SCRATCH/repo"; curl -sS -H "x-sync-token: ${syncCapability}" -D "$SCRATCH/export.headers" "${exportUrl}" -o "$SCRATCH/source.tgz"; ROOTS_JSON="$(sed -n 's/^x-sync-roots:[[:space:]]*//p' "$SCRATCH/export.headers" | tr -d '\\r' | tail -1)"; test -n "$ROOTS_JSON"; tar -xzf "$SCRATCH/source.tgz" -C "$SCRATCH/repo".
2. Edit source under "$SCRATCH/repo/src" to implement the dashboard enhancement requested by the user. Prefer adding a compact section to src/routes/dashboard/+page.svelte using the dashboard's existing client-side data, recentRuns, and explicit empty states; avoid adding new API routes unless absolutely necessary.
3. Confirm the edited dashboard source contains "${DASHBOARD_MARKER}".
4. Push one atomic HMR/live-sync generation:
   cd "$SCRATCH/repo" && GEN="$(cat /proc/sys/kernel/random/uuid)" && node -e 'const roots=JSON.parse(process.argv[1]); if (!Array.isArray(roots) || roots.length === 0) process.exit(2); for (const root of roots) console.log(root);' "$ROOTS_JSON" > "$SCRATCH/declared-roots" && : > "$SCRATCH/existing-roots" && while IFS= read -r p; do [ ! -e "$p" ] || printf '%s\\n' "$p" >> "$SCRATCH/existing-roots"; done < "$SCRATCH/declared-roots" && tar -czf "$SCRATCH/sync.tgz" -T "$SCRATCH/existing-roots" && curl -sS -X POST --data-binary @"$SCRATCH/sync.tgz" -H 'content-type: application/gzip' -H "x-sync-token: ${syncCapability}" -H "x-sync-generation: $GEN" -H "x-sync-service: ${service}" -H "x-sync-roots: $ROOTS_JSON" "${syncUrl}" | tee /sandbox/work/preview-ui-gan-sync-${iterations + 1}.json.
5. Smoke the live app after sync: poll ${previewUrl}/api/health until HTTP 200, then request ${routes.join(", ")} and verify the route does not return HTTP 500 and the served HTML has no ReferenceError or each_key_duplicate.

User task:
${intent}
${feedback}`;
  lastGenerator = await agent(
    generatorPrompt,
    agentOptions(`generate #${iterations + 1}`, builder, generatorBudget),
  );

  phase("Verify");

  // Phase 3 impact-review gates — workflow-side, AFTER generation and BEFORE
  // accepting the capture. A gate failure feeds lastVerdict into the next
  // iteration exactly like a source-capture failure does. Multi-service only.
  if (runGates) {
    // 1. Convergence: parse sync.sh's OWN receipts from the agent-produced
    //    sync.log (not the agent's prose self-report).
    const convOut = unwrapCommand(
      await action(
        "workspace/command",
        {
          cliWorkspace: true,
          workspaceRef: workspace,
          command: convergenceCommand(),
          cwd: "/sandbox/work",
          timeoutMs: 120000,
          helperPod: true,
          helperTimeoutMinutes: 120,
        },
        { label: `convergence gate #${iterations + 1}`, allowFailure: true },
      ),
    );
    const convergence = parseConvergence(convOut.stdout, services);
    if (!convergence.ok) {
      lastVerdict = {
        accepted: false,
        summary: "convergence gate failed",
        skipped: convergence.reason,
        failing: [
          `${convergence.reason}${
            convergence.missing.length ? ": missing " + convergence.missing.join(", ") : ""
          }`,
        ],
      };
      iterations += 1;
      continue;
    }
    iterationGeneration = convergence.generation;

    // 2. Route-smoke: per-service health + the frontend targetRoutes; non-500 and
    //    no ReferenceError / each_key_duplicate in the served HTML.
    const smokeOut = unwrapCommand(
      await action(
        "workspace/command",
        {
          cliWorkspace: true,
          workspaceRef: workspace,
          command: smokeCommand(routes, previewUrl),
          cwd: "/sandbox/work",
          timeoutMs: 900000,
          helperPod: true,
          helperTimeoutMinutes: 120,
        },
        { label: `route-smoke gate #${iterations + 1}`, allowFailure: true },
      ),
    );
    const smoke = parseRouteSmoke(smokeOut.stdout);
    if (!smoke.ok) {
      lastVerdict = {
        accepted: false,
        summary: "route-smoke gate failed",
        skipped: "route_smoke_failed",
        failing: smoke.failures.length ? smoke.failures.slice(0, 8) : ["no route-smoke output"],
      };
      iterations += 1;
      continue;
    }

    // 3. Per-service probe: cataloged /__run lanes for services WITH testCommands
    //    (workflow-builder: check/test-unit; orchestrator: contract); health-poll
    //    only for services without (never a lane that would 404).
    const probeOut = unwrapCommand(
      await action(
        "workspace/command",
        {
          cliWorkspace: true,
          workspaceRef: workspace,
          command: probeCommand(services),
          cwd: "/sandbox/work",
          timeoutMs: 1500000,
          helperPod: true,
          helperTimeoutMinutes: 120,
        },
        { label: `probe gate #${iterations + 1}`, allowFailure: true },
      ),
    );
    const probe = parseProbe(probeOut.stdout);
    if (!probe.ok) {
      lastVerdict = {
        accepted: false,
        summary: "per-service probe gate failed",
        skipped: "probe_failed",
        failing: probe.failures.length ? probe.failures.slice(0, 8) : ["no probe output"],
      };
      iterations += 1;
      continue;
    }
    lastGateSummary = {
      convergence: {
        generation: convergence.generation,
        services: convergence.applied,
      },
      routeSmoke: { checked: smoke.checked },
      probe: { checked: probe.checked },
    };
  }

  // diffScope enforcement before snapshot: read every receiver's final source diff
  // relative to its immutable adopted baseline. The receipts are bound to one shared
  // sync generation, so a helper pod's clean pod-local checkout cannot hide changes
  // and a later generation can prove that an earlier addition was removed. Snapshot
  // below must then capture this exact generation.
  if (enforceDiffScope) {
    const diffOut = unwrapCommand(
      await action(
        "workspace/command",
        {
          cliWorkspace: true,
          workspaceRef: workspace,
          command: diffScopeCommand(scopeReceivers),
          cwd: "/sandbox/work",
          timeoutMs: 120000,
          helperPod: true,
          helperTimeoutMinutes: 120,
        },
        { label: `diffScope gate #${iterations + 1}`, allowFailure: true },
      ),
    );
    const receiptReview = parseDiffScopeReceipts(
      diffOut.stdout,
      scopeReceivers,
      iterationGeneration,
    );
    if (!receiptReview.ok) {
      lastDiffScope = {
        allow: diffScopeAllow,
        changed: [],
        inScope: [],
        excluded: [],
        outOfScope: [],
        generation: receiptReview.generation,
        receipts: receiptReview.receipts,
        errors: receiptReview.errors,
      };
      lastVerdict = {
        accepted: false,
        summary: "diffScope receiver receipt gate failed",
        skipped: "diff_scope_receipt_invalid",
        failing: receiptReview.errors.slice(0, 12),
      };
      iterations += 1;
      continue;
    }
    iterationGeneration = receiptReview.generation;
    const scope = classifyDiffScope(receiptReview.changed, diffScopeAllow);
    lastDiffScope = {
      allow: diffScopeAllow,
      changed: receiptReview.changed,
      inScope: scope.inScope,
      excluded: scope.excluded,
      outOfScope: scope.outOfScope,
      generation: receiptReview.generation,
      receipts: receiptReview.receipts,
      errors: [],
    };
    if (scope.outOfScope.length > 0) {
      lastVerdict = {
        accepted: false,
        summary: "capture contains out-of-scope changes",
        skipped: "out_of_scope_changes",
        failing: [
          `out_of_scope_changes: ${scope.outOfScope.slice(0, 12).join(", ")}`,
        ],
      };
      iterations += 1;
      continue;
    }
  }

  const snapshotGate = await action(
    "dev/preview-snapshot",
    {
      nodeId: "generate",
      iteration: iterations + 1,
      services,
    },
    { label: `snapshot HMR generation #${iterations + 1}`, allowFailure: true },
  );
  const capture = dataOf(snapshotGate);
  if (capture.ok !== true) {
    lastVerdict = {
      accepted: false,
      summary: "source-capture gate failed",
      failing: [
        String(
          capture.skipped ??
            capture.error ??
            "source capture failed",
        ).slice(0, 1000),
      ],
    };
    iterations += 1;
    continue;
  }
  if (
    enforceDiffScope &&
    iterationGeneration &&
    capture.generation !== iterationGeneration
  ) {
    lastVerdict = {
      accepted: false,
      summary: "source-capture generation did not match diffScope receipts",
      skipped: "snapshot_generation_mismatch",
      failing: [
        `snapshot generation ${String(capture.generation ?? "none")} did not match ${iterationGeneration}`,
      ],
    };
    iterations += 1;
    continue;
  }

  acceptedCapture = capture;
  lastVerdict = {
    accepted: true,
    summary: `source-capture gate passed for ${routes.join(", ")}`,
    failing: [],
  };
  accepted = true;
  iterations += 1;
}

if (!accepted) {
  throw new Error(
    `preview UI GAN did not satisfy verification after ${iterations} iteration(s): ${JSON.stringify(lastVerdict)}`,
  );
}

phase("Promote");
const capture = acceptedCapture ?? dataOf(await action(
  "dev/preview-snapshot",
  {
    nodeId: "generate",
    iteration: iterations,
    services,
  },
  { label: "snapshot accepted live-sync generation" },
));
if (capture.ok !== true) {
  throw new Error(`dev/preview-snapshot failed: ${String(capture.skipped ?? capture.error ?? "unknown")}`);
}

const promote = await action(
  "dev/preview-promote",
  {
    iteration: iterations,
    bestIteration: iterations,
    draft: true,
    title: pydanticUiProfile
      ? "Preview UI development: requested experience"
      : "Preview UI development: dashboard enhancement",
    bodyMarkdown:
      "Automated draft PR from the host-orchestrated preview UI-development GAN workflow.\\n\\n" +
      `- agent: ${agentSlug}\\n` +
      `- builder profile: ${builderProfile}\\n` +
      `- agent runtime: ${agentType}\\n` +
      `- model: ${REQUIRED_MODEL}\\n` +
      `- services: ${services.join(", ")}\\n` +
      `- target routes: ${routes.join(", ")}\\n\\n` +
      "## Requested task\\n" +
      intent,
    services,
  },
  { label: "open draft pull request" },
);
const promotionReceipt = strictReceipt(promote);

// Freeze-on-retain: a retained preview stops accepting live-sync generations so
// the promoted PR stays the authoritative capture. Skipped for an interactive
// handoff (the user keeps editing). Freeze failure never fails the run — the
// draft PR already exists; the outcome is recorded instead.
let freezeOutcome = null;
if (retainAfterCompletion) {
  if (interactiveHandoff) {
    freezeOutcome = { attempted: false, frozen: false, skipped: "interactive-handoff" };
  } else {
    const freeze = dataOf(
      await action(
        "dev/preview-freeze",
        { services },
        { label: "freeze retained preview live-sync", allowFailure: true },
      ),
    );
    freezeOutcome =
      freeze.ok === true
        ? { attempted: true, frozen: true, receipt: freeze }
        : {
            attempted: true,
            frozen: false,
            error: String(
              freeze.error ?? freeze.message ?? freeze.skipped ?? "dev/preview-freeze failed",
            ).slice(0, 1000),
          };
  }
}

// Interactive handoff: keep a persistent agent session alive against the still
// live-sync-open preview (mirrors microservice-dev-session's session/spawn
// pattern — direct sessions default to interactive/autoTerminate=false).
let handoffSession = null;
if (interactiveHandoff) {
  handoffSession = dataOf(
    await action(
      "session/spawn",
      {
        agentSlug,
        instructions:
          `You are the interactive developer continuing work on the retained workflow-builder preview for these services: **${services.join(", ")}**.\n` +
          `A draft PR was already opened from the automated run; further edits are yours to iterate on.\n` +
          `- Live preview: ${previewUrl} (routes: ${routes.join(", ")}).\n` +
          (multiService
            ? "- The seeded checkout is at /sandbox/work/repo (run /sandbox/work/activate-repo.sh first). Per-service sync config is in /sandbox/work/.syncenv.d/. After each logical edit generation, run `/sandbox/work/sync.sh > /sandbox/work/sync.log 2>&1` once and confirm an APPLIED receipt for every service plus the final global `SYNCED ... convergence=healthy` line.\n"
            : `- Pull source from the dev-sync sidecar export endpoint ${exportUrl} and push atomic generations to ${syncUrl} with header x-sync-token: ${syncCapability}.\n`) +
          "- Do not commit or push from the session. Receiver-owned `dev/preview-snapshot` and `dev/preview-promote` actions are the only source-capture and GitHub-write authorities.\n" +
          "- Never touch auth/sign-in code.\n\n" +
          "Original user task for context:\n" +
          intent,
      },
      { label: "interactive handoff session" },
    ),
  );
}

return {
  controlAction: "submit_preview_pr",
  controlOutcome: "submitted",
  accepted,
  iterations,
  builderProfile,
  agentSlug,
  agentType,
  model: REQUIRED_MODEL,
  service,
  services,
  targetRoutes: routes,
  browseUrl: previewUrl,
  preview,
  plan: typeof plan === "string" ? plan.slice(0, 4000) : plan,
  verifier: lastVerdict,
  generatorSummary:
    typeof lastGenerator === "string" ? lastGenerator.slice(0, 4000) : lastGenerator,
  sourceCapture: capture,
  captureReceipt: capture,
  promotionReceipt,
  pullRequestReceipt: promotionReceipt,
  pullRequest: promotionReceipt.pullRequest ?? null,
  // Opt-in only: with the flags absent/false the output shape above is unchanged.
  ...(retainAfterCompletion
    ? { retainAfterCompletion: true, ttlHours, sandboxTimeoutSeconds, freezeOutcome }
    : {}),
  ...(interactiveHandoff
    ? {
        handoff: true,
        interactiveHandoff: true,
        sessionId: handoffSession?.sessionId ?? null,
        sessionUrl: String(handoffSession?.url ?? handoffSession?.sessionUrl ?? ""),
      }
    : {}),
  ...(runGates ? { impactReview: true, gateSummary: lastGateSummary } : {}),
  ...(enforceDiffScope ? { diffScopeReview: lastDiffScope } : {}),
};
