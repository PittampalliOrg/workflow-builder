export const meta = {
  name: "preview-ui-development-gan",
  description:
    "Preview-local automated UI development loop for workflow-builder: enter the existing app-live preview's live-sync mode, use a deterministic dashboard contract plus the GLM JuiceFS Dapr agent to implement a dashboard UI change, verify the HMR-served app, snapshot the exact live-sync generation, and open a draft PR.",
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
        items: { type: "string" },
        default: ["/dashboard"],
      },
      maxIterations: { type: "integer", minimum: 1, maximum: 3, default: 2 },
      agentSlug: {
        type: "string",
        default: "glm-juicefs-builder-agent",
        description:
          "Server-selected agent slug. The host lifecycle supplies this; it is not preview authority.",
      },
      keepPreview: {
        anyOf: [{ type: "boolean" }, { type: "string", enum: ["true", "false"] }],
        default: "true",
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

const DEFAULT_AGENT = "glm-juicefs-builder-agent";
const REQUIRED_MODEL = "zai/glm-5.2";
const DEFAULT_SERVICE = "workflow-builder";
const DEFAULT_ROUTES = ["/dashboard"];
const DASHBOARD_MARKER = "Preview Development Status";

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

function agentOptions(label, agentSlug, extra = {}) {
  return {
    label,
    agent: agentSlug,
    model: REQUIRED_MODEL,
    isolation: "shared",
    sandbox: {
      workspaceRef: workspace,
      cwd: "/sandbox/work",
      maxTurns: extra.maxTurns ?? 24,
      timeoutMinutes: extra.timeoutMinutes ?? 30,
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

const t = args ?? {};
const intent = typeof t.intent === "string" ? t.intent.trim() : "";
if (!intent) throw new Error("intent is required");

const service = typeof t.service === "string" && t.service ? t.service : DEFAULT_SERVICE;
const services = asStringArray(t.services, [service]);
const routes = asStringArray(t.targetRoutes, DEFAULT_ROUTES);
const maxIterations = Math.max(1, Math.min(3, Number(t.maxIterations ?? 2) || 2));
const agentSlug =
  typeof t.agentSlug === "string" && t.agentSlug.length > 0
    ? t.agentSlug
    : DEFAULT_AGENT;

phase("Dev mode");
const preview = await action(
  "dev/preview",
  {
    service,
    services,
    mode: "preview-native",
    adopt: true,
    timeoutSeconds: 86400,
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
const syncUrl = String(info.syncUrl ?? "");
const syncCapability = String(info.syncCapability ?? "");
if (!previewUrl || !syncUrl || !syncCapability) {
  throw new Error("preview live-sync metadata is incomplete");
}
const exportUrl = sidecarExportUrlFromSyncUrl(syncUrl);
if (!exportUrl || exportUrl === syncUrl) {
  throw new Error("preview live-sync sidecar export endpoint is incomplete");
}

const fallbackContract = {
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

phase("Generate");
let accepted = false;
let iterations = 0;
let lastVerdict = null;
let lastGenerator = null;

while (!accepted && iterations < maxIterations) {
  const feedback = lastVerdict
    ? `\nPrevious verifier feedback to address:\n${JSON.stringify(lastVerdict)}\n`
    : "";
  lastGenerator = await agent(
    `You are the GLM builder for a workflow-builder preview UI-development run.

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
${feedback}`,
    agentOptions(`generate #${iterations + 1}`, agentSlug, {
      maxTurns: 24,
      timeoutMinutes: 35,
    }),
  );

  phase("Verify");
  const gateCommand = `set -eu
SCRATCH=/sandbox/work/preview-ui-gan-gate-${iterations + 1}
rm -rf "$SCRATCH"
mkdir -p "$SCRATCH/repo"
curl -sS -H "x-sync-token: ${syncCapability}" -D "$SCRATCH/export.headers" "${exportUrl}" -o "$SCRATCH/source.tgz"
tar -xzf "$SCRATCH/source.tgz" -C "$SCRATCH/repo"
test -f "$SCRATCH/repo/src/routes/dashboard/+page.svelte"
grep -R "${DASHBOARD_MARKER}" "$SCRATCH/repo/src/routes/dashboard/+page.svelte"
if find "$SCRATCH/repo/src" -path '*/auth/*' -o -path '*/auth.*' | grep -q .; then
  echo "auth source exists in export; ensuring generated marker was not placed there"
  ! grep -R "${DASHBOARD_MARKER}" "$SCRATCH/repo/src/routes/auth" "$SCRATCH/repo/src/lib/server/auth" 2>/dev/null
fi
for i in $(seq 1 60); do
  code=$(curl -sS -o /tmp/preview-ui-gan-health-${iterations + 1}.txt -w '%{http_code}' "${previewUrl}/api/health" || true)
  [ "$code" = "200" ] && break
  sleep 2
done
LOGIN=/tmp/preview-ui-gan-login-${iterations + 1}.json
JAR=/tmp/preview-ui-gan-cookie-${iterations + 1}.jar
curl -sS -c "$JAR" -H 'content-type: application/json' -X POST "${previewUrl}/api/v1/auth/sign-in" --data '{"email":"admin@example.com","password":"developer"}' > "$LOGIN" || true
for route in ${routes.map((route) => `'${route.replace(/'/g, "'\\''")}'`).join(" ")}; do
  html="$SCRATCH/route$(echo "$route" | tr '/' '_').html"
  code=$(curl -sS -b "$JAR" -L -o "$html" -w '%{http_code}' "${previewUrl}$route" || true)
  [ "$code" = "200" ] || { echo "route $route returned HTTP $code"; exit 20; }
  ! grep -E 'ReferenceError|each_key_duplicate|Internal Error|500' "$html"
done
echo '{"accepted":true,"summary":"deterministic HMR gate passed"}' > /sandbox/work/preview-ui-gan-gate-${iterations + 1}.json
`;
  const gate = await action(
    "workspace/command",
    {
      cliWorkspace: true,
      helperPod: true,
      helperTimeoutMinutes: 10,
      workspaceRef: workspace,
      command: gateCommand,
      cwd: "/sandbox/work",
      timeoutMs: 600000,
    },
    { label: `deterministic HMR gate #${iterations + 1}`, allowFailure: true },
  );
  const gateBase = dataOf(gate);
  const gateResult = gateBase.data?.result ?? gateBase.result ?? gateBase.data ?? gateBase;
  const gateOk =
    gateBase.success === true &&
    (gateResult.exitCode === 0 || gateBase.exitCode === 0 || gateResult.accepted === true);
  if (!gateOk) {
    lastVerdict = {
      accepted: false,
      summary: "deterministic gate failed",
      failing: [
        String(
          gateBase.error ??
            gateResult.error ??
            gateResult.stderr ??
            gateResult.stdout ??
            "gate failed",
        ).slice(0, 1000),
      ],
    };
    iterations += 1;
    continue;
  }

  lastVerdict = {
    accepted: true,
    summary: `deterministic HMR gate passed for ${routes.join(", ")}`,
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
const snapshot = await action(
  "dev/preview-snapshot",
  {
    nodeId: "generate",
    iteration: iterations,
    services,
  },
  { label: "snapshot accepted live-sync generation" },
);
const capture = dataOf(snapshot);
if (capture.ok !== true) {
  throw new Error(`dev/preview-snapshot failed: ${String(capture.skipped ?? capture.error ?? "unknown")}`);
}

const promote = await action(
  "dev/preview-promote",
  {
    iteration: iterations,
    bestIteration: iterations,
    draft: true,
    title: "Preview UI development: dashboard enhancement",
    bodyMarkdown:
      "Automated draft PR from the host-orchestrated preview UI-development GAN workflow.\\n\\n" +
      `- agent: ${agentSlug}\\n` +
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

return {
  controlAction: "submit_preview_pr",
  controlOutcome: "submitted",
  accepted,
  iterations,
  agentSlug,
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
};
