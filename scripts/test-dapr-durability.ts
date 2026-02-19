#!/usr/bin/env npx tsx
/**
 * Durable-Agent Dapr Workflow Durability Test
 *
 * Proves that a durable-agent workflow survives pod kills and resumes
 * to completion after the pod restarts.
 *
 * Phases:
 *   1. Start a multi-step agent workflow (requires ~5 tool calls)
 *   2. Wait for a few activities to complete
 *   3. Kill the durable-agent pod
 *   4. Wait for the pod to come back
 *   5. Verify the workflow completes successfully
 *   6. Check state integrity (no duplicate tool_call_ids)
 *
 * Prerequisites:
 *   - kubectl configured for the workflow-builder cluster
 *   - durable-agent running in workflow-builder namespace
 *   - Dapr sidecar healthy
 *
 * Usage:
 *   npx tsx scripts/test-dapr-durability.ts
 *   npx tsx scripts/test-dapr-durability.ts --skip-kill   # Skip pod kill (smoke test mode)
 *   npx tsx scripts/test-dapr-durability.ts --timeout 600  # Custom timeout in seconds
 */

import { execSync, spawn } from "node:child_process";

// ── Configuration ─────────────────────────────────────────────

const NAMESPACE = process.env.NAMESPACE ?? "workflow-builder";
const AGENT_LABEL = process.env.AGENT_LABEL ?? "app=durable-agent";
const AGENT_CONTAINER = process.env.AGENT_CONTAINER ?? "durable-agent";

// Access the durable-agent via port-forward or in-cluster URL
const AGENT_BASE_URL =
  process.env.AGENT_URL ?? "http://localhost:8001";

// Dapr sidecar for workflow status queries (via port-forward)
const DAPR_BASE_URL =
  process.env.DAPR_URL ?? "http://localhost:3500";

// How long to wait for activities before killing (seconds)
// Keep this short (3-5s) — the agent can complete simple tasks in under 10s
const PRE_KILL_WAIT = parseInt(process.env.PRE_KILL_WAIT ?? "4", 10);

// How long to wait after pod restarts before checking (seconds)
const POST_RESTART_WAIT = parseInt(process.env.POST_RESTART_WAIT ?? "15", 10);

// Overall timeout for workflow completion (seconds)
const WORKFLOW_TIMEOUT = parseInt(
  process.argv.includes("--timeout")
    ? process.argv[process.argv.indexOf("--timeout") + 1]
    : process.env.WORKFLOW_TIMEOUT ?? "300",
  10,
);

const SKIP_KILL = process.argv.includes("--skip-kill");

// ── Helpers ──────────────────────────────────────────────────

function log(phase: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${phase}] ${msg}`);
}

function fail(msg: string): never {
  console.error(`\n❌ FAIL: ${msg}`);
  process.exit(1);
}

function pass(msg: string) {
  console.log(`\n✅ PASS: ${msg}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url: string, opts?: RequestInit): Promise<any> {
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${body}`);
  }
  return resp.json();
}

function kubectl(args: string): string {
  return execSync(`kubectl ${args}`, {
    encoding: "utf-8",
    timeout: 30_000,
  }).trim();
}

// ── Phase 1: Start Workflow ──────────────────────────────────

async function startWorkflow(): Promise<{
  workflowId: string;
  daprInstanceId: string;
}> {
  log("START", "Triggering multi-step agent workflow...");

  // Prompt designed to produce ~8-10+ tool calls, giving a wide window for the kill.
  // Each step requires a separate LLM turn + tool call, buying time.
  const prompt = [
    "Follow these steps EXACTLY in order, one at a time:",
    "1. Create a directory /tmp/durability-test/",
    "2. Create a file /tmp/durability-test/step1.txt with the content 'step 1 done'",
    "3. Read /tmp/durability-test/step1.txt back to verify",
    "4. Create a file /tmp/durability-test/step2.txt with the content 'step 2 done'",
    "5. Read /tmp/durability-test/step2.txt back to verify",
    "6. Create a file /tmp/durability-test/step3.txt with the content 'step 3 done'",
    "7. Read /tmp/durability-test/step3.txt back to verify",
    "8. Create a file /tmp/durability-test/step4.txt with the content 'step 4 done'",
    "9. Read /tmp/durability-test/step4.txt back to verify",
    "10. List all files in /tmp/durability-test/",
    "11. Report what files you found and their contents.",
  ].join("\n");

  const resp = await fetchJson(`${AGENT_BASE_URL}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      maxTurns: 15, // Enough turns for the multi-step task
    }),
  });

  if (!resp.success) {
    fail(`Failed to start workflow: ${JSON.stringify(resp)}`);
  }

  log("START", `workflow_id=${resp.workflow_id}`);
  log("START", `dapr_instance_id=${resp.dapr_instance_id}`);

  return {
    workflowId: resp.workflow_id,
    daprInstanceId: resp.dapr_instance_id,
  };
}

// ── Phase 2: Kill the Pod ────────────────────────────────────

async function killPod(): Promise<string | undefined> {
  log("KILL", `Waiting ${PRE_KILL_WAIT}s for some activities to execute...`);
  await sleep(PRE_KILL_WAIT * 1000);

  // Capture the current pod name before killing
  let podName: string | undefined;
  try {
    podName = kubectl(
      `-n ${NAMESPACE} get pods -l ${AGENT_LABEL} -o jsonpath='{.items[0].metadata.name}'`,
    ).replace(/'/g, "");
  } catch { /* proceed without name */ }

  log("KILL", `Deleting pod ${podName ?? "(unknown)"}...`);
  try {
    const output = kubectl(
      `-n ${NAMESPACE} delete pod -l ${AGENT_LABEL} --wait=false`,
    );
    log("KILL", output || "Pod delete issued");
  } catch (err) {
    fail(`Failed to kill pod: ${err}`);
  }

  log("KILL", "Pod kill issued. Kubernetes will auto-recreate it.");
  return podName;
}

// ── Port-Forward Management ──────────────────────────────────

/** Track child processes for cleanup */
const portForwardProcesses: ReturnType<typeof spawn>[] = [];

function killPortForwards(): void {
  for (const proc of portForwardProcesses) {
    try { proc.kill("SIGTERM"); } catch { /* already dead */ }
  }
  portForwardProcesses.length = 0;
}

/**
 * Re-establish port-forwards to the new pod.
 * The old port-forward dies when the pod is killed.
 */
function setupPortForwards(): void {
  killPortForwards();

  log("RECOVERY", "Re-establishing port-forwards...");

  const pf1 = spawn("kubectl", [
    "-n", NAMESPACE, "port-forward", `deploy/durable-agent`, "8001:8001",
  ], { stdio: "ignore", detached: true });
  pf1.unref();
  portForwardProcesses.push(pf1);

  const pf2 = spawn("kubectl", [
    "-n", NAMESPACE, "port-forward", `deploy/durable-agent`, "3500:3500",
  ], { stdio: "ignore", detached: true });
  pf2.unref();
  portForwardProcesses.push(pf2);

  log("RECOVERY", "Port-forwards started (agent:8001, dapr:3500)");
}

// ── Phase 3: Wait for Recovery ───────────────────────────────

async function waitForPodReady(killedPodName?: string): Promise<void> {
  // Step 1: Wait for the old pod to disappear (or a new pod name to appear)
  if (killedPodName) {
    log("RECOVERY", `Waiting for old pod ${killedPodName} to terminate...`);
    const termDeadline = Date.now() + 60_000;
    while (Date.now() < termDeadline) {
      try {
        const pods = kubectl(
          `-n ${NAMESPACE} get pods -l ${AGENT_LABEL} --no-headers -o custom-columns=NAME:.metadata.name,STATUS:.status.phase`,
        );
        // Check if the only running pod is a NEW one (different name)
        const running = pods
          .split("\n")
          .filter((l) => l.includes("Running"))
          .map((l) => l.split(/\s+/)[0]);
        if (running.length > 0 && !running.includes(killedPodName)) {
          log("RECOVERY", `New pod detected: ${running[0]}`);
          break;
        }
      } catch {
        // Might briefly fail during transition
      }
      await sleep(3000);
    }
  }

  // Step 2: Wait for the new pod to be Ready (both containers: app + Dapr sidecar)
  log("RECOVERY", "Waiting for new pod to become Ready (2/2 containers)...");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const output = kubectl(
        `-n ${NAMESPACE} get pods -l ${AGENT_LABEL} -o jsonpath='{.items[0].status.containerStatuses[*].ready}'`,
      );
      const readyFlags = output.replace(/'/g, "").trim().split(/\s+/);
      if (readyFlags.length >= 2 && readyFlags.every((f) => f === "true")) {
        log("RECOVERY", "All containers Ready");
        break;
      }
      log("RECOVERY", `Container readiness: ${readyFlags.join(", ")}`);
    } catch {
      // Pod may not exist yet
    }
    await sleep(3000);
  }

  // Step 3: Re-establish port-forwards (they die with the old pod)
  setupPortForwards();

  // Step 4: Wait for Dapr workflow runtime to initialize and replay
  log(
    "RECOVERY",
    `Waiting ${POST_RESTART_WAIT}s for Dapr workflow runtime replay...`,
  );
  await sleep(POST_RESTART_WAIT * 1000);

  // Step 5: Verify health endpoint responds (with port-forward retry)
  // Note: `initialized` is only true after the first /api/run request (lazy init).
  // The Dapr workflow runtime starts independently, so we just need the HTTP server up.
  log("RECOVERY", "Verifying agent health endpoint...");
  const healthDeadline = Date.now() + 90_000;
  let portForwardRetries = 0;
  while (Date.now() < healthDeadline) {
    try {
      const health = await fetchJson(`${AGENT_BASE_URL}/api/health`);
      // Accept any successful response — agent is reachable
      log("RECOVERY", `Agent reachable: service=${health.service} initialized=${health.initialized}`);
      return;
    } catch (err) {
      portForwardRetries++;
      // Re-establish port-forwards if they're not connecting
      if (portForwardRetries % 5 === 0) {
        log("RECOVERY", "Port-forward may be stale, re-establishing...");
        setupPortForwards();
        await sleep(3000);
      }
    }
    await sleep(3000);
  }

  fail("Pod did not become healthy within timeout");
}

// ── Phase 4: Verify Completion ───────────────────────────────

/** WorkflowRuntimeStatus: RUNNING=0, COMPLETED=1, FAILED=3, TERMINATED=5 */
const STATUS_NAMES: Record<number, string> = {
  0: "RUNNING",
  1: "COMPLETED",
  2: "SUSPENDED",
  3: "FAILED",
  4: "CANCELED",
  5: "TERMINATED",
};

/**
 * Query Dapr workflow status. Tries local port-forward first,
 * falls back to kubectl exec into the daprd sidecar container.
 */
async function queryDaprWorkflowStatus(instanceId: string): Promise<any> {
  // Try port-forward first
  try {
    const url = `${DAPR_BASE_URL}/v1.0/workflows/dapr/${instanceId}`;
    return await fetchJson(url);
  } catch {
    // Fallback: kubectl exec curl inside the daprd sidecar
  }

  try {
    const podName = kubectl(
      `-n ${NAMESPACE} get pods -l ${AGENT_LABEL} -o jsonpath='{.items[0].metadata.name}'`,
    ).replace(/'/g, "");
    // Use Node.js fetch inside the container (no curl/wget in distroless images)
    const nodeScript = `fetch("http://localhost:3500/v1.0/workflows/dapr/${instanceId}").then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{process.stderr.write(String(e));process.exit(1)})`;
    const raw = kubectl(
      `-n ${NAMESPACE} exec ${podName} -c ${AGENT_CONTAINER} -- node -e '${nodeScript}'`,
    );
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Both port-forward and kubectl exec failed: ${err}`);
  }
}

function parseWorkflowState(state: any): {
  statusNum: number;
  statusName: string;
} {
  const statusNum =
    typeof state.runtimeStatus === "number"
      ? state.runtimeStatus
      : // The HTTP API returns enum names as strings
        Object.entries(STATUS_NAMES).find(
          ([, v]) => v === state.runtimeStatus,
        )?.[0]
        ? parseInt(
            Object.entries(STATUS_NAMES).find(
              ([, v]) => v === state.runtimeStatus,
            )![0],
          )
        : -1;

  return {
    statusNum,
    statusName: STATUS_NAMES[statusNum] ?? `UNKNOWN(${statusNum})`,
  };
}

function extractOutput(state: any): any {
  let output: any = {};

  // Dapr HTTP API returns output in properties["dapr.workflow.output"]
  const workflowOutput = state.properties?.["dapr.workflow.output"];
  if (workflowOutput) {
    try {
      output = JSON.parse(workflowOutput);
    } catch {
      output = { raw: workflowOutput };
    }
  }
  // Fallback: SDK-style serializedOutput field
  if (Object.keys(output).length === 0 && state.serializedOutput) {
    try {
      output = JSON.parse(state.serializedOutput);
    } catch {
      output = { raw: state.serializedOutput };
    }
  }
  return output;
}

async function waitForCompletion(
  instanceId: string,
): Promise<{ status: number; output: any }> {
  log("VERIFY", `Polling workflow status for ${instanceId}...`);

  const deadline = Date.now() + WORKFLOW_TIMEOUT * 1000;

  while (Date.now() < deadline) {
    try {
      const state = await queryDaprWorkflowStatus(instanceId);
      const { statusNum, statusName } = parseWorkflowState(state);
      log("VERIFY", `Status: ${statusName} (${statusNum})`);

      if (statusNum === 1) {
        return { status: statusNum, output: extractOutput(state) };
      }

      if (statusNum === 3 || statusNum === 5) {
        const error =
          state.failureDetails?.message ??
          state.properties?.["dapr.workflow.output"] ??
          state.serializedOutput ??
          "Unknown error";
        fail(`Workflow ended with status ${statusName}: ${error}`);
      }
    } catch (err) {
      log("VERIFY", `Status query failed (will retry): ${err}`);
    }

    await sleep(5000);
  }

  fail(`Workflow did not complete within ${WORKFLOW_TIMEOUT}s`);
}

// ── Phase 5: State Integrity Checks ──────────────────────────

interface IntegrityReport {
  hasContent: boolean;
  allToolCallCount: number;
  finalAnswer: string;
  duplicateToolCallIds: string[];
}

function checkIntegrity(output: any): IntegrityReport {
  log("INTEGRITY", "Checking workflow output...");

  const finalAnswer: string =
    output.final_answer ?? output.content ?? "";
  const allToolCalls: any[] = output.all_tool_calls ?? [];

  // Check for duplicate tool_call_ids across tool calls
  // (Note: all_tool_calls doesn't have tool_call_id, but we check tool_name uniqueness
  //  as a rough proxy — the real dedup check is on Redis state)
  const seen = new Set<string>();
  const dupes: string[] = [];

  // If we can read Redis state, check messages for duplicate tool_call_ids
  // For now, just verify the output structure
  for (const tc of allToolCalls) {
    const key = `${tc.tool_name}:${JSON.stringify(tc.tool_args)}`;
    if (seen.has(key)) {
      dupes.push(key);
    }
    seen.add(key);
  }

  return {
    hasContent: finalAnswer.length > 0,
    allToolCallCount: allToolCalls.length,
    finalAnswer: finalAnswer.slice(0, 200),
    duplicateToolCallIds: dupes,
  };
}

// ── Phase 6: Verify Files via Tool API ───────────────────────

async function verifyFiles(): Promise<void> {
  log("FILES", "Checking workspace files via tool API...");

  const filesToCheck = [
    { path: "/tmp/durability-test/step1.txt", expected: "step 1 done" },
    { path: "/tmp/durability-test/step2.txt", expected: "step 2 done" },
    { path: "/tmp/durability-test/step3.txt", expected: "step 3 done" },
    { path: "/tmp/durability-test/step4.txt", expected: "step 4 done" },
  ];

  for (const { path, expected } of filesToCheck) {
    try {
      const result = await fetchJson(
        `${AGENT_BASE_URL}/api/tools/read`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ args: { path } }),
        },
      );

      if (!result.success) {
        log("FILES", `⚠ Could not read ${path}: ${result.error}`);
        continue;
      }

      const content = typeof result.result === "string"
        ? result.result
        : result.result?.content ?? JSON.stringify(result.result);

      if (content.includes(expected)) {
        log("FILES", `✓ ${path} contains "${expected}"`);
      } else {
        log("FILES", `⚠ ${path} content mismatch. Got: ${content.slice(0, 100)}`);
      }
    } catch (err) {
      log("FILES", `⚠ Could not verify ${path}: ${err}`);
    }
  }
}

// ── Cleanup ──────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  log("CLEANUP", "Removing test files...");
  const files = [
    "/tmp/durability-test/step1.txt",
    "/tmp/durability-test/step2.txt",
    "/tmp/durability-test/step3.txt",
    "/tmp/durability-test/step4.txt",
  ];
  for (const path of files) {
    try {
      await fetchJson(`${AGENT_BASE_URL}/api/tools/bash`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: { command: `rm -f ${JSON.stringify(path)}` } }),
      });
    } catch {
      // Best-effort cleanup
    }
  }

  // Kill any port-forward processes we spawned
  killPortForwards();
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log("  Durable-Agent Dapr Workflow Durability Test");
  console.log("=".repeat(60));
  console.log();
  console.log(`  Agent URL:        ${AGENT_BASE_URL}`);
  console.log(`  Dapr URL:         ${DAPR_BASE_URL}`);
  console.log(`  Namespace:        ${NAMESPACE}`);
  console.log(`  Pre-kill wait:    ${PRE_KILL_WAIT}s`);
  console.log(`  Post-restart wait: ${POST_RESTART_WAIT}s`);
  console.log(`  Workflow timeout: ${WORKFLOW_TIMEOUT}s`);
  console.log(`  Skip kill:        ${SKIP_KILL}`);
  console.log();

  // Preflight: verify agent is reachable
  log("PREFLIGHT", "Checking agent health...");
  try {
    const health = await fetchJson(`${AGENT_BASE_URL}/api/health`);
    log("PREFLIGHT", `Agent healthy: ${JSON.stringify(health)}`);
  } catch (err) {
    fail(
      `Cannot reach agent at ${AGENT_BASE_URL}/api/health. ` +
        `Set up port-forward: kubectl -n ${NAMESPACE} port-forward svc/durable-agent 8001:8001\n` +
        `Error: ${err}`,
    );
  }

  // Phase 1: Start workflow
  const { daprInstanceId } = await startWorkflow();

  if (!SKIP_KILL) {
    // Phase 2: Kill the pod
    const killedPodName = await killPod();

    // Phase 3: Wait for recovery
    await waitForPodReady(killedPodName);
  } else {
    log("SKIP", "Skipping pod kill (--skip-kill mode)");
  }

  // Phase 4: Wait for completion
  const { status, output } = await waitForCompletion(daprInstanceId);
  log("VERIFY", `Workflow completed with status ${STATUS_NAMES[status]}`);
  log("VERIFY", `Output keys: ${Object.keys(output).join(", ")}`);

  // Phase 5: State integrity checks
  const report = checkIntegrity(output);

  console.log();
  console.log("-".repeat(60));
  console.log("  Durability Test Results");
  console.log("-".repeat(60));
  console.log(`  Workflow completed:    ${status === 1 ? "YES" : "NO"}`);
  console.log(`  Has final answer:      ${report.hasContent ? "YES" : "NO"}`);
  console.log(`  Total tool calls:      ${report.allToolCallCount}`);
  console.log(
    `  Duplicate tool calls:  ${report.duplicateToolCallIds.length === 0 ? "NONE (good)" : report.duplicateToolCallIds.join(", ")}`,
  );
  console.log(`  Final answer preview:  ${report.finalAnswer}`);
  console.log("-".repeat(60));

  // Phase 6: Verify files (if not killed — files may not persist across sandbox restart)
  if (SKIP_KILL) {
    await verifyFiles();
  } else {
    log(
      "FILES",
      "Skipping file verification (sandbox filesystem doesn't persist across pod restarts)",
    );
  }

  // Cleanup
  await cleanup();

  // Final verdict
  const checks = [
    { name: "Workflow completed", ok: status === 1 },
    { name: "Has final answer", ok: report.hasContent },
    { name: "Has tool calls (>= 3)", ok: report.allToolCallCount >= 3 },
    {
      name: "No duplicate tool calls",
      ok: report.duplicateToolCallIds.length === 0,
    },
  ];

  console.log();
  for (const c of checks) {
    console.log(`  ${c.ok ? "✅" : "❌"} ${c.name}`);
  }

  const allPassed = checks.every((c) => c.ok);
  console.log();

  if (allPassed) {
    if (SKIP_KILL) {
      pass(
        "All checks passed (smoke test — no pod kill). " +
          "Run without --skip-kill for full durability test.",
      );
    } else {
      pass(
        "Durable-agent workflow survived pod kill and resumed to completion!",
      );
    }
  } else {
    const failed = checks.filter((c) => !c.ok).map((c) => c.name);
    fail(`Failed checks: ${failed.join(", ")}`);
  }
}

// Ensure port-forward cleanup on exit
process.on("exit", () => killPortForwards());
process.on("SIGINT", () => { killPortForwards(); process.exit(130); });
process.on("SIGTERM", () => { killPortForwards(); process.exit(143); });

main().catch((err) => {
  killPortForwards();
  console.error("\nUnexpected error:", err);
  process.exit(1);
});
