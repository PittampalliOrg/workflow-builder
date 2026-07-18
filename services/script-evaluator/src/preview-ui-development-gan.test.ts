import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateScript, validateScript } from "./sandbox.js";

const script = readFileSync(
  new URL(
    "../../../scripts/fixtures/dynamic-scripts/preview-ui-development-gan.js",
    import.meta.url,
  ),
  "utf8",
);

const previewUrl = "https://preview.example.test";
const syncUrl = "http://10.0.0.5:8092/__sync";
const syncCapability = "a".repeat(64);
const promotionReceipt = {
  ok: true,
  draft: true,
  receiptId: `pspr_${"e".repeat(64)}`,
  pullRequest: {
    repository: "PittampalliOrg/workflow-builder",
    number: 42,
    baseSha: "b".repeat(40),
    headSha: "e".repeat(40),
  },
};

async function drive(
  extraArgs: Record<string, unknown> = {},
  options: {
    freezeResult?: Record<string, unknown>;
    commandResponder?: (command: string) => unknown;
  } = {},
) {
  const args = {
    intent: "Add a preview development status panel",
    ...extraArgs,
  };
  const completedResults: Record<
    string,
    | { status: "done"; value: unknown }
    | { status: "error"; value: unknown; errorCode?: string }
  > = {};
  const knownCallIds: string[] = [];
  const tasks: Array<Record<string, unknown>> = [];
  let result = await evaluateScript({
    script,
    args,
    budget: { total: 1_000_000, spent: 0 },
    completedResults,
    knownCallIds,
    seenLogCount: 0,
    features: { actions: true },
  });

  for (let round = 0; result.status === "need" && round < 1_000; round += 1) {
    expect(result.tasks.length).toBeGreaterThan(0);
    for (const task of result.tasks) {
      tasks.push(task as unknown as Record<string, unknown>);
      let value: unknown;
      if (task.kind === "sleep") {
        value = null;
      } else if (task.kind === "agent") {
        value = "implemented the dashboard enhancement and pushed one HMR generation";
      } else if (task.kind === "action") {
        switch (task.actionSlug) {
          case "dev/preview": {
            const svcList =
              Array.isArray(args.services) && args.services.length > 0
                ? (args.services as string[])
                : ["workflow-builder"];
            value = {
              ok: true,
              ready: true,
              url: previewUrl,
              services: svcList.map((svc) => ({
                service: svc,
                ok: true,
                info: {
                  ready: true,
                  url: previewUrl,
                  syncUrl,
                  syncCapability,
                  repoSubdir: svc === "workflow-builder" ? "." : `services/${svc}`,
                  syncPaths: ["src"],
                  healthPath: "/api/health",
                },
              })),
            };
            break;
          }
          case "workspace/command": {
            const cmd = String(
              (task.args as Record<string, unknown>)?.command ?? "",
            );
            value = options.commandResponder
              ? options.commandResponder(cmd)
              : { ok: true };
            break;
          }
          case "dev/preview-snapshot":
            value = { ok: true, artifactId: "artifact-1" };
            break;
          case "dev/preview-promote":
            value = promotionReceipt;
            break;
          case "dev/preview-freeze":
            value = options.freezeResult ?? { ok: true, frozen: true };
            break;
          case "session/spawn":
            value = {
              sessionId: "sess-1",
              url: "https://session.example.test/sess-1",
            };
            break;
          default:
            throw new Error(`unexpected action ${String(task.actionSlug)}`);
        }
      } else {
        throw new Error(`unexpected task kind ${String(task.kind)}`);
      }
      completedResults[task.callId] = { status: "done", value };
      knownCallIds.push(task.callId);
    }
    result = await evaluateScript({
      script,
      args,
      budget: { total: 1_000_000, spent: 0 },
      completedResults,
      knownCallIds,
      seenLogCount: 0,
      features: { actions: true },
    });
  }
  return { result, tasks };
}

function actionSlugs(tasks: Array<Record<string, unknown>>) {
  return tasks
    .filter((task) => task.kind === "action")
    .map((task) => task.actionSlug);
}

function previewTask(tasks: Array<Record<string, unknown>>) {
  return tasks.find((task) => task.actionSlug === "dev/preview");
}

// The workspace/command tasks the fixture emits (seed + the four impact-review
// gate nodes), in dispatch order, as their raw command strings.
function commandStrings(tasks: Array<Record<string, unknown>>): string[] {
  return tasks
    .filter((task) => task.actionSlug === "workspace/command")
    .map((task) => String((task.args as Record<string, unknown>).command ?? ""));
}

function findCommand(
  tasks: Array<Record<string, unknown>>,
  marker: string,
): string | undefined {
  return commandStrings(tasks).find((cmd) => cmd.includes(marker));
}

function gateResult(stdout: string, exitCode = 0) {
  return { success: true, result: { exitCode, stdout, stderr: "" } };
}

const TEST_PROBE_LANES: Record<string, string[]> = {
  "workflow-builder": ["check", "test-unit"],
  "workflow-orchestrator": ["contract"],
};

// A workspace/command responder: healthy for every impact-review gate by default,
// with per-gate stdout overrides so a single failing gate can be injected. The
// seed command (identified by its PY_PREVIEW_METADATA heredoc) returns { ok: true }
// exactly like the pre-Phase-3 default.
function makeResponder(
  services: string[],
  routes: string[],
  overrides: {
    convergence?: string;
    smoke?: string;
    probe?: string;
    diffscope?: string;
  } = {},
): (command: string) => unknown {
  const convergence =
    overrides.convergence ??
    [
      ...services.map(
        (s) =>
          `APPLIED ${
            s === "workflow-builder" ? "." : "services/" + s
          } → HTTP 200 in 1s (service=${s} generation=g1 attempt=1)`,
      ),
      `SYNCED generation=g1 services=${services.length} convergence=healthy`,
    ].join("\n");
  const smoke =
    overrides.smoke ??
    [
      ...services.map((s) => `SMOKE kind=health service=${s} http=200`),
      ...routes.map((r) => `SMOKE kind=route route=${r} http=200 marker=none`),
    ].join("\n");
  const probe =
    overrides.probe ??
    services
      .flatMap((s) =>
        TEST_PROBE_LANES[s]
          ? TEST_PROBE_LANES[s].map(
              (lane) => `PROBE kind=lane service=${s} lane=${lane} exit=0`,
            )
          : [`PROBE kind=health service=${s} http=200`],
      )
      .join("\n");
  const diffscope = overrides.diffscope ?? "";
  return (command: string): unknown => {
    if (command.includes("impact-review-convergence")) return gateResult(convergence);
    if (command.includes("impact-review-smoke")) return gateResult(smoke);
    if (command.includes("impact-review-probe")) return gateResult(probe);
    if (command.includes("impact-review-diffscope")) return gateResult(diffscope);
    return { ok: true };
  };
}

describe("preview UI development GAN child fixture", () => {
  it("validates with the additive retain/handoff inputs", async () => {
    const result = await validateScript(script);
    expect(result.ok, result.error).toBe(true);
    expect(result.meta).toMatchObject({
      name: "preview-ui-development-gan",
      input: { required: ["intent"] },
    });
  });

  it("keeps today's behavior byte-for-byte when the new inputs are absent", async () => {
    const { result, tasks } = await drive();
    expect(result.status, result.error?.message).toBe("done");
    expect(actionSlugs(tasks)).toEqual([
      "dev/preview",
      "dev/preview-snapshot",
      "dev/preview-promote",
    ]);
    expect(previewTask(tasks)?.args).toMatchObject({ timeoutSeconds: 86400 });
    const output = result.returnValue as Record<string, unknown>;
    expect(output).toMatchObject({
      controlAction: "submit_preview_pr",
      controlOutcome: "submitted",
      accepted: true,
    });
    expect(output).not.toHaveProperty("retainAfterCompletion");
    expect(output).not.toHaveProperty("freezeOutcome");
    expect(output).not.toHaveProperty("handoff");
    expect(output).not.toHaveProperty("sessionId");
    expect(output).not.toHaveProperty("sessionUrl");
  });

  it("derives the sandbox timeout from ttlHours when retaining", async () => {
    const { result, tasks } = await drive({
      retainAfterCompletion: true,
      ttlHours: 6,
    });
    expect(result.status, result.error?.message).toBe("done");
    expect(previewTask(tasks)?.args).toMatchObject({ timeoutSeconds: 21600 });
    expect(result.returnValue).toMatchObject({
      retainAfterCompletion: true,
      ttlHours: 6,
      sandboxTimeoutSeconds: 21600,
    });
  });

  it("clamps the retained lifetime to the platform sandbox ceiling", async () => {
    const { result, tasks } = await drive({
      retainAfterCompletion: true,
      ttlHours: 24,
    });
    expect(result.status, result.error?.message).toBe("done");
    expect(previewTask(tasks)?.args).toMatchObject({ timeoutSeconds: 86400 });
    expect(result.returnValue).toMatchObject({ sandboxTimeoutSeconds: 86400 });
  });

  it("freezes live-sync after promotion on retain without handoff", async () => {
    const { result, tasks } = await drive({ retainAfterCompletion: true });
    expect(result.status, result.error?.message).toBe("done");
    expect(actionSlugs(tasks)).toEqual([
      "dev/preview",
      "dev/preview-snapshot",
      "dev/preview-promote",
      "dev/preview-freeze",
    ]);
    const freeze = tasks.find((task) => task.actionSlug === "dev/preview-freeze");
    expect(freeze?.args).toMatchObject({ services: ["workflow-builder"] });
    expect(result.returnValue).toMatchObject({
      freezeOutcome: {
        attempted: true,
        frozen: true,
        receipt: { ok: true, frozen: true },
      },
      pullRequestReceipt: { receiptId: promotionReceipt.receiptId, draft: true },
    });
  });

  it("records the freeze failure without failing the promoted run", async () => {
    const { result, tasks } = await drive(
      { retainAfterCompletion: true },
      { freezeResult: { success: false, error: "sidecar unreachable" } },
    );
    expect(result.status, result.error?.message).toBe("done");
    expect(
      tasks.some((task) => task.actionSlug === "dev/preview-freeze"),
    ).toBe(true);
    expect(result.returnValue).toMatchObject({
      controlOutcome: "submitted",
      freezeOutcome: {
        attempted: true,
        frozen: false,
        error: "sidecar unreachable",
      },
      pullRequestReceipt: { receiptId: promotionReceipt.receiptId, draft: true },
    });
  });

  it("skips freeze and spawns a persistent session on interactive handoff", async () => {
    const { result, tasks } = await drive({
      retainAfterCompletion: true,
      ttlHours: 8,
      interactiveHandoff: true,
    });
    expect(result.status, result.error?.message).toBe("done");
    expect(actionSlugs(tasks)).toEqual([
      "dev/preview",
      "dev/preview-snapshot",
      "dev/preview-promote",
      "session/spawn",
    ]);
    const spawn = tasks.find((task) => task.actionSlug === "session/spawn");
    expect(spawn?.args).toMatchObject({
      agentSlug: "glm-juicefs-builder-agent",
    });
    expect(result.returnValue).toMatchObject({
      handoff: true,
      interactiveHandoff: true,
      sessionId: "sess-1",
      sessionUrl: "https://session.example.test/sess-1",
      sandboxTimeoutSeconds: 28800,
      freezeOutcome: {
        attempted: false,
        frozen: false,
        skipped: "interactive-handoff",
      },
    });
  });

  it("hands off without retention using today's sandbox lifetime", async () => {
    const { result, tasks } = await drive({ interactiveHandoff: true });
    expect(result.status, result.error?.message).toBe("done");
    expect(previewTask(tasks)?.args).toMatchObject({ timeoutSeconds: 86400 });
    expect(
      tasks.some((task) => task.actionSlug === "dev/preview-freeze"),
    ).toBe(false);
    const output = result.returnValue as Record<string, unknown>;
    expect(output).toMatchObject({
      handoff: true,
      sessionId: "sess-1",
      sessionUrl: "https://session.example.test/sess-1",
    });
    expect(output).not.toHaveProperty("retainAfterCompletion");
    expect(output).not.toHaveProperty("sandboxTimeoutSeconds");
  });

  it("seeds every requested service and drives one shared sync on multi-service runs", async () => {
    const services = ["workflow-builder", "workflow-orchestrator"];
    const { result, tasks } = await drive({
      services,
      sourceRevision: "a".repeat(40),
    });
    expect(result.status, result.error?.message).toBe("done");
    // A workspace seed runs between provisioning and capture; the single-service
    // path (asserted elsewhere) emits no workspace/command at all.
    expect(actionSlugs(tasks)).toEqual([
      "dev/preview",
      "workspace/command",
      "dev/preview-snapshot",
      "dev/preview-promote",
    ]);
    const seed = tasks.find((task) => task.actionSlug === "workspace/command");
    expect(seed?.args).toMatchObject({
      cwd: "/sandbox/work",
      cliWorkspace: true,
      workspaceRef: "@workspace",
      helperPod: true,
      helperTimeoutMinutes: 120,
    });
    const command = String(
      (seed?.args as Record<string, unknown>).command ?? "",
    );
    // The seed carries a base64 PREVIEWS_B64 that decodes to both services.
    const match = command.match(/export PREVIEWS_B64='([^']+)'/);
    expect(match).toBeTruthy();
    const previews = JSON.parse(
      Buffer.from(match![1], "base64").toString("utf8"),
    ) as Array<{ service: string }>;
    expect(previews.map((entry) => entry.service)).toEqual(services);
    // The seed body is the ported SEED_SHELL: per-service .syncenv.d config, a
    // union sparse checkout, and sync.sh copied into the workspace.
    expect(command).toContain(".syncenv.d");
    expect(command).toContain("sparse-checkout");
    expect(command).toContain(
      'cp "$LOCAL_REPO/scripts/dev-sync/sync.sh" /sandbox/work/sync.sh',
    );
    // Capture + promotion carry the full service set.
    const snapshot = tasks.find(
      (task) => task.actionSlug === "dev/preview-snapshot",
    );
    expect(snapshot?.args).toMatchObject({ services });
    const promote = tasks.find(
      (task) => task.actionSlug === "dev/preview-promote",
    );
    expect(promote?.args).toMatchObject({ services });
    expect(result.returnValue).toMatchObject({
      services,
      accepted: true,
      controlOutcome: "submitted",
    });
  });

  it("SEED_SHELL materializes per-service .syncenv.d config and a union sparse checkout list", async () => {
    // Extract the ported Python metadata block from a rendered seed command and
    // run it exactly as the shell heredoc would, feeding a well-formed 2-service
    // PREVIEWS_B64. This proves the multi-service seed writes one .syncenv.d file
    // per service and a UNION of sparse-checkout paths.
    const { tasks } = await drive({
      services: ["workflow-builder", "workflow-orchestrator"],
      sourceRevision: "a".repeat(40),
    });
    const command = String(
      (tasks.find((task) => task.actionSlug === "workspace/command")
        ?.args as Record<string, unknown>).command ?? "",
    );
    const startMarker = "python3 - <<'PY_PREVIEW_METADATA'\n";
    const endMarker = "\nPY_PREVIEW_METADATA";
    const start = command.indexOf(startMarker);
    expect(start).toBeGreaterThanOrEqual(0);
    const bodyStart = start + startMarker.length;
    const bodyEnd = command.indexOf(endMarker, bodyStart);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const pythonBody = command.slice(bodyStart, bodyEnd);

    const wellFormed = [
      {
        service: "workflow-builder",
        ok: true,
        info: {
          ready: true,
          url: "http://10.1.0.1:3000",
          syncUrl: "http://10.1.0.1:8092/__sync",
          syncCapability: "t".repeat(64),
          repoSubdir: ".",
          syncPaths: ["src"],
          healthPath: "/api/health",
        },
      },
      {
        service: "workflow-orchestrator",
        ok: true,
        info: {
          ready: true,
          url: "http://10.1.0.2:8080",
          syncUrl: "http://10.1.0.2:8092/__sync",
          syncCapability: "u".repeat(64),
          repoSubdir: "services/workflow-orchestrator",
          syncPaths: ["src"],
          healthPath: "/health",
        },
      },
    ];
    const previewsB64 = Buffer.from(JSON.stringify(wellFormed)).toString(
      "base64",
    );
    const work = mkdtempSync(join(tmpdir(), "gan-seed-"));
    try {
      execFileSync("python3", [], {
        input: pythonBody,
        cwd: work,
        env: { ...process.env, PREVIEWS_B64: previewsB64 },
      });
      // One config file per service.
      expect(existsSync(join(work, ".syncenv.d", "workflow-builder"))).toBe(true);
      expect(
        existsSync(join(work, ".syncenv.d", "workflow-orchestrator")),
      ).toBe(true);
      const wbConfig = readFileSync(
        join(work, ".syncenv.d", "workflow-builder"),
        "utf8",
      );
      // Values are shell-quoted with shlex.quote (shell-safe values stay bare).
      expect(wbConfig).toContain("SERVICE=workflow-builder");
      expect(wbConfig).toContain("SUBDIR=.");
      expect(wbConfig).toContain("SYNCURL=http://10.1.0.1:8092/__sync");
      expect(wbConfig).toContain("HEALTHURL=http://10.1.0.1:3000/api/health");
      const woConfig = readFileSync(
        join(work, ".syncenv.d", "workflow-orchestrator"),
        "utf8",
      );
      expect(woConfig).toContain("SUBDIR=services/workflow-orchestrator");
      expect(woConfig).toContain("SERVICE=workflow-orchestrator");
      // Union of sparse-checkout paths across both services (+ the always-present
      // sync.sh path), sorted.
      const sparse = readFileSync(join(work, ".sparse-paths"), "utf8")
        .split("\n")
        .filter(Boolean);
      expect(sparse).toContain("scripts/dev-sync/sync.sh");
      expect(sparse).toContain("src");
      expect(sparse).toContain("services/workflow-orchestrator/src");
      // Persisted service summary matches the requested set.
      const summary = readFileSync(
        join(work, ".preview-services-summary"),
        "utf8",
      ).trim();
      expect(summary).toBe("workflow-builder,workflow-orchestrator");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  const MULTI = ["workflow-builder", "workflow-orchestrator"];
  const REV = "a".repeat(40);

  it("leaves multi-service behavior byte-for-byte when impactReview is off", async () => {
    // The Phase-2 multi-service path must not emit ANY gate node without the
    // opt-in — only the seed workspace/command runs.
    const { result, tasks } = await drive({ services: MULTI, sourceRevision: REV });
    expect(result.status, result.error?.message).toBe("done");
    expect(actionSlugs(tasks)).toEqual([
      "dev/preview",
      "workspace/command",
      "dev/preview-snapshot",
      "dev/preview-promote",
    ]);
    expect(commandStrings(tasks)).toHaveLength(1); // just the seed
    const output = result.returnValue as Record<string, unknown>;
    expect(output).not.toHaveProperty("impactReview");
    expect(output).not.toHaveProperty("gateSummary");
    expect(output).not.toHaveProperty("diffScopeReview");
  });

  it("runs convergence, route-smoke, probe and diffScope gates and accepts when all pass", async () => {
    const routes = ["/dashboard"];
    const { result, tasks } = await drive(
      { services: MULTI, sourceRevision: REV, impactReview: true, targetRoutes: routes },
      { commandResponder: makeResponder(MULTI, routes) },
    );
    expect(result.status, result.error?.message).toBe("done");
    // The four gate nodes run (in order) between the seed and the snapshot.
    expect(actionSlugs(tasks)).toEqual([
      "dev/preview",
      "workspace/command", // seed
      "workspace/command", // convergence
      "workspace/command", // route-smoke
      "workspace/command", // probe
      "workspace/command", // diffScope
      "dev/preview-snapshot",
      "dev/preview-promote",
    ]);
    expect(findCommand(tasks, "impact-review-convergence")).toBeTruthy();
    expect(findCommand(tasks, "impact-review-smoke")).toBeTruthy();
    expect(findCommand(tasks, "impact-review-probe")).toBeTruthy();
    expect(findCommand(tasks, "impact-review-diffscope")).toBeTruthy();
    for (const task of tasks.filter(
      (candidate) => candidate.actionSlug === "workspace/command",
    )) {
      expect(task.args).toMatchObject({
        helperPod: true,
        helperTimeoutMinutes: 120,
      });
    }
    const output = result.returnValue as Record<string, unknown>;
    expect(output).toMatchObject({
      accepted: true,
      controlOutcome: "submitted",
      impactReview: true,
      gateSummary: {
        convergence: { generation: "g1", services: MULTI },
      },
    });
  });

  it("fails the convergence gate when sync.log has no SYNCED convergence=healthy line", async () => {
    const { result, tasks } = await drive(
      { services: MULTI, sourceRevision: REV, impactReview: true, maxIterations: 1 },
      {
        commandResponder: makeResponder(MULTI, ["/dashboard"], {
          convergence:
            "APPLIED . → HTTP 200 in 1s (service=workflow-builder generation=g1 attempt=1)\n" +
            "sync transaction pending: generation=g1; rerun sync.sh to replay the immutable fanout",
        }),
      },
    );
    expect(result.status).toBe("script_error");
    expect(String(result.error?.message)).toContain("convergence_unhealthy");
    // Short-circuits before smoke/probe/snapshot.
    expect(findCommand(tasks, "impact-review-convergence")).toBeTruthy();
    expect(findCommand(tasks, "impact-review-smoke")).toBeUndefined();
    expect(
      tasks.some((task) => task.actionSlug === "dev/preview-snapshot"),
    ).toBe(false);
  });

  it("fails the convergence gate when an expected service is missing an APPLIED receipt", async () => {
    const { result } = await drive(
      { services: MULTI, sourceRevision: REV, impactReview: true, maxIterations: 1 },
      {
        commandResponder: makeResponder(MULTI, ["/dashboard"], {
          // orchestrator never APPLIED, but the count line claims 2.
          convergence:
            "APPLIED . → HTTP 200 in 1s (service=workflow-builder generation=g1 attempt=1)\n" +
            "SYNCED generation=g1 services=2 convergence=healthy",
        }),
      },
    );
    expect(result.status).toBe("script_error");
    expect(String(result.error?.message)).toContain("convergence_missing_service");
    expect(String(result.error?.message)).toContain("workflow-orchestrator");
  });

  it("fails the route-smoke gate on a 5xx route", async () => {
    const { result, tasks } = await drive(
      { services: MULTI, sourceRevision: REV, impactReview: true, maxIterations: 1 },
      {
        commandResponder: makeResponder(MULTI, ["/dashboard"], {
          smoke:
            "SMOKE kind=health service=workflow-builder http=200\n" +
            "SMOKE kind=health service=workflow-orchestrator http=200\n" +
            "SMOKE kind=route route=/dashboard http=500 marker=none",
        }),
      },
    );
    expect(result.status).toBe("script_error");
    expect(String(result.error?.message)).toContain("route_smoke_failed");
    // Reached smoke but not probe/snapshot.
    expect(findCommand(tasks, "impact-review-smoke")).toBeTruthy();
    expect(findCommand(tasks, "impact-review-probe")).toBeUndefined();
  });

  it("fails the route-smoke gate when a route serves each_key_duplicate", async () => {
    const { result } = await drive(
      { services: MULTI, sourceRevision: REV, impactReview: true, maxIterations: 1 },
      {
        commandResponder: makeResponder(MULTI, ["/dashboard"], {
          smoke:
            "SMOKE kind=health service=workflow-builder http=200\n" +
            "SMOKE kind=health service=workflow-orchestrator http=200\n" +
            "SMOKE kind=route route=/dashboard http=200 marker=each_key_duplicate",
        }),
      },
    );
    expect(result.status).toBe("script_error");
    expect(String(result.error?.message)).toContain("each_key_duplicate");
  });

  it("fails the per-service probe gate when a cataloged lane exits nonzero", async () => {
    const { result, tasks } = await drive(
      { services: MULTI, sourceRevision: REV, impactReview: true, maxIterations: 1 },
      {
        commandResponder: makeResponder(MULTI, ["/dashboard"], {
          probe:
            "PROBE kind=lane service=workflow-builder lane=check exit=1\n" +
            "PROBE kind=lane service=workflow-builder lane=test-unit exit=0\n" +
            "PROBE kind=lane service=workflow-orchestrator lane=contract exit=0",
        }),
      },
    );
    expect(result.status).toBe("script_error");
    expect(String(result.error?.message)).toContain("probe_failed");
    expect(String(result.error?.message)).toContain("lane check");
    expect(findCommand(tasks, "impact-review-probe")).toBeTruthy();
    expect(
      tasks.some((task) => task.actionSlug === "dev/preview-snapshot"),
    ).toBe(false);
  });

  it("probes cataloged lanes for services with testCommands and health-only for those without", async () => {
    const services = ["workflow-builder", "function-router"];
    const { tasks } = await drive(
      { services, sourceRevision: REV, impactReview: true },
      { commandResponder: makeResponder(services, ["/dashboard"]) },
    );
    const probe = findCommand(tasks, "impact-review-probe") ?? "";
    // workflow-builder runs its cataloged /__run lanes...
    expect(probe).toContain("__run?cmd=check");
    expect(probe).toContain("__run?cmd=test-unit");
    expect(probe).toContain("PROBE kind=lane service=workflow-builder lane=check");
    // ...but function-router has NO testCommands, so it is health-poll only —
    // never a /__run lane that would 404.
    expect(probe).toContain("PROBE kind=health service=function-router");
    expect(probe).not.toContain("service=function-router lane=");
    expect(probe).not.toMatch(/function-router[\s\S]*__run\?cmd=/);
  });

  it("rejects out-of-scope changes with skip reason out_of_scope_changes", async () => {
    const { result, tasks } = await drive(
      { services: MULTI, sourceRevision: REV, impactReview: true, maxIterations: 1 },
      {
        commandResponder: makeResponder(MULTI, ["/dashboard"], {
          // README.md is outside every service's synced src root (the derived scope).
          diffscope:
            " M src/routes/dashboard/+page.svelte\n M README.md",
        }),
      },
    );
    expect(result.status).toBe("script_error");
    expect(String(result.error?.message)).toContain("out_of_scope_changes");
    expect(String(result.error?.message)).toContain("README.md");
    expect(findCommand(tasks, "impact-review-diffscope")).toBeTruthy();
    expect(
      tasks.some((task) => task.actionSlug === "dev/preview-snapshot"),
    ).toBe(false);
  });

  it("enforces an explicit diffScope allowlist that is tighter than the sync roots", async () => {
    const { result } = await drive(
      {
        services: MULTI,
        sourceRevision: REV,
        impactReview: true,
        maxIterations: 1,
        diffScope: ["src/routes/dashboard"],
      },
      {
        commandResponder: makeResponder(MULTI, ["/dashboard"], {
          // In "src" but outside the tighter explicit allowlist.
          diffscope: " M src/lib/server/foo.ts",
        }),
      },
    );
    expect(result.status).toBe("script_error");
    expect(String(result.error?.message)).toContain("out_of_scope_changes");
    expect(String(result.error?.message)).toContain("src/lib/server/foo.ts");
  });

  it("excludes generated build artifacts from the diffScope check (PR #688 churn)", async () => {
    const { result } = await drive(
      { services: MULTI, sourceRevision: REV, impactReview: true },
      {
        commandResponder: makeResponder(MULTI, ["/dashboard"], {
          diffscope:
            " M src/routes/dashboard/+page.svelte\n" +
            " M scripts/seed-workflows.bundle.js\n" +
            " M services/shared/dev-preview-service-catalog.json\n" +
            " M drizzle/meta/_journal.json",
        }),
      },
    );
    expect(result.status, result.error?.message).toBe("done");
    const output = result.returnValue as Record<string, unknown>;
    expect(output).toMatchObject({ accepted: true, impactReview: true });
    const review = output.diffScopeReview as Record<string, string[]>;
    expect(review.excluded).toEqual([
      "scripts/seed-workflows.bundle.js",
      "services/shared/dev-preview-service-catalog.json",
      "drizzle/meta/_journal.json",
    ]);
    expect(review.outOfScope).toEqual([]);
    expect(review.inScope).toEqual(["src/routes/dashboard/+page.svelte"]);
  });

  it("does not enforce diffScope or gates on the single-service default path", async () => {
    // impactReview is multi-service only; on a single service it is inert and the
    // proven behavior is unchanged.
    const { result, tasks } = await drive({ impactReview: true });
    expect(result.status, result.error?.message).toBe("done");
    expect(actionSlugs(tasks)).toEqual([
      "dev/preview",
      "dev/preview-snapshot",
      "dev/preview-promote",
    ]);
    const output = result.returnValue as Record<string, unknown>;
    expect(output).not.toHaveProperty("impactReview");
    expect(output).not.toHaveProperty("diffScopeReview");
  });
});
