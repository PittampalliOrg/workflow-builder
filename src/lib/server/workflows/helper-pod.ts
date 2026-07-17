/**
 * Ephemeral CLI "workspace helper" pod for server-orchestrated git operations
 * (e.g. Promote → PR: rehydrate a source bundle → branch → push → open a PR).
 *
 * Reuses the same provisioning the deterministic cliWorkspace gate uses
 * (maybeProvisionAgentWorkflowHost), but with a dedicated session-id suffix so it
 * is INDEPENDENT of the run's liveness — Promote runs long after the run's own
 * sandbox is reaped. The pod boots cli-agent-py :8002 (no agent turn) with git +
 * GITHUB_TOKEN + INTERNAL_API_TOKEN, and runs a fixed command via
 * `/internal/workspace/command`. Mirrors the postCommand transport in
 * cli-workspace-command/+server.ts (node http, long socket idle).
 */

import http from "node:http";
import https from "node:https";
import { deleteCliStorageForSession } from "$lib/server/kube/client";
import {
  maybeProvisionAgentWorkflowHost,
  sessionHostAppId,
} from "$lib/server/sessions/agent-workflow-host";
import { resolveWorkflowGithubToken } from "$lib/server/workflows/github-token";
import type { AgentConfig } from "$lib/types/agents";
import { env } from "$env/dynamic/private";

export type HelperCmdResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};
const DEFAULT_TIMEOUT_MS = 600_000;
const HTTP_SLACK_MS = 60_000;

/** Provision (or adopt) a helper pod for an execution + a purpose suffix. */
export async function provisionWorkspaceHelperPod(
  executionId: string,
  suffix: string,
  opts?: {
    withGithubToken?: boolean;
    /** Explicit least-privilege token; takes precedence over the legacy resolver. */
    githubToken?: string | null;
    timeoutMinutes?: number;
    sharedWorkspaceKey?: string;
  },
): Promise<{
  baseUrl: string;
  token: string;
  githubToken: string | null;
  helperSessionId: string;
  sharedWorkspaceKey: string;
  sandboxName: string | null;
} | null> {
  const helperSessionId = `${executionId}__${suffix}`;
  const sharedWorkspaceKey =
    opts?.sharedWorkspaceKey ?? `${executionId}__${suffix}`;
  const token = env.INTERNAL_API_TOKEN ?? process.env.INTERNAL_API_TOKEN ?? "";
  const githubToken =
    opts?.githubToken?.trim() ||
    (opts?.withGithubToken ? await resolveWorkflowGithubToken() : null);

  try {
    const prov = await maybeProvisionAgentWorkflowHost({
      sessionId: helperSessionId,
      agentConfig: { runtime: "claude-code-cli" } as AgentConfig,
      workflowExecutionId: executionId,
      benchmarkRunId: null,
      benchmarkInstanceId: null,
      timeoutMinutes: opts?.timeoutMinutes ?? 15,
      sessionSecretEnv: githubToken ? { GITHUB_TOKEN: githubToken } : null,
      sharedWorkspaceKey,
    });
    if (prov?.status === "ready" && prov.baseUrl) {
      return {
        baseUrl: prov.baseUrl,
        token,
        githubToken,
        helperSessionId,
        sharedWorkspaceKey,
        sandboxName: prov.sandboxName ?? null,
      };
    }
  } catch (err) {
    console.warn(
      `[helper-pod] provision failed for ${executionId}/${suffix}:`,
      err instanceof Error ? err.message : err,
    );
  }
  return null;
}

/** SEA endpoint + token, resolved with the same env contract the provision
 * path uses (maybeProvisionAgentWorkflowHost in agent-workflow-host.ts). */
function sandboxExecutionApi(): { baseUrl: string; token: string } | null {
  const baseUrl = (
    env.SANDBOX_EXECUTION_API_URL ??
    env.HOST_EXECUTION_API_URL ??
    process.env.SANDBOX_EXECUTION_API_URL ??
    process.env.HOST_EXECUTION_API_URL ??
    ""
  ).trim();
  if (!baseUrl) return null;
  const token = (
    env.SANDBOX_EXECUTION_API_TOKEN ??
    env.HOST_EXECUTION_API_TOKEN ??
    process.env.SANDBOX_EXECUTION_API_TOKEN ??
    process.env.HOST_EXECUTION_API_TOKEN ??
    ""
  ).trim();
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

/** Delete the helper Sandbox CR after the fixed helper command has completed.
 *
 * Delegated to sandbox-execution-api's DELETE /api/v1/agent-workflow-hosts/
 * {appId}: the preview-control broker mounts no SA token and has no RBAC on
 * sandboxes.agents.x-k8s.io, so the former direct kube delete ALWAYS failed
 * there and the helper lingered until shutdownTime (hard-killed by the pod
 * activeDeadline first). SEA is the privileged controller — its foreground CR
 * delete also GCs the ownerRef'd cred Secret + PVCs. Callers with kube RBAC
 * (the BFF) additionally get best-effort PV storage cleanup below.
 */
export async function cleanupWorkspaceHelperPod(
  helper: {
    sandboxName?: string | null;
    helperSessionId?: string | null;
  } | null,
): Promise<"deleted" | "missing" | "skipped" | "failed"> {
  const explicitSandboxName = helper?.sandboxName?.trim();
  const helperSessionId = helper?.helperSessionId?.trim();
  const agentAppId = helperSessionId
    ? sessionHostAppId(helperSessionId)
    : explicitSandboxName?.startsWith("agent-host-")
      ? explicitSandboxName.slice("agent-host-".length)
      : null;
  if (!agentAppId) return "skipped";
  let outcome: "deleted" | "missing";
  try {
    const api = sandboxExecutionApi();
    if (!api) {
      throw new Error("SANDBOX_EXECUTION_API_URL is not configured");
    }
    const response = await fetch(
      `${api.baseUrl}/api/v1/agent-workflow-hosts/${encodeURIComponent(agentAppId)}`,
      {
        method: "DELETE",
        headers: api.token ? { Authorization: `Bearer ${api.token}` } : {},
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      outcome?: string;
      message?: string;
      detail?: string;
    };
    if (!response.ok) {
      throw new Error(
        (typeof body.detail === "string" && body.detail) ||
          `sandbox-execution-api HTTP ${response.status}`,
      );
    }
    if (body.outcome === "deleted") {
      outcome = "deleted";
    } else if (body.outcome === "not-found") {
      outcome = "missing";
    } else {
      throw new Error(
        (typeof body.message === "string" && body.message) ||
          `unexpected cleanup outcome ${JSON.stringify(body.outcome ?? null)}`,
      );
    }
  } catch (err) {
    console.warn(
      `[helper-pod] cleanup failed for ${agentAppId}:`,
      err instanceof Error ? err.message : err,
    );
    return "failed";
  }
  if (helperSessionId) {
    // Best-effort: SEA's foreground delete already GC'd the namespaced
    // storage; this direct call additionally reclaims cluster-scoped PVs
    // where the caller has kube RBAC (the BFF). No-RBAC callers log only.
    try {
      await deleteCliStorageForSession(helperSessionId);
    } catch (err) {
      console.warn(
        `[helper-pod] storage cleanup failed for ${helperSessionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return outcome;
}

/** Run a fixed command in a helper pod via cli-agent-py /internal/workspace/command. */
export async function runHelperCommand(
  baseUrl: string,
  token: string,
  command: string,
  cwd: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<HelperCmdResult | null> {
  const budgetMs = Math.max(1_000, Math.floor(timeoutMs));
  const payload = JSON.stringify({
    command,
    cwd,
    timeout: Math.ceil(budgetMs / 1000),
  });
  const u = new URL(`${baseUrl}/internal/workspace/command`);
  const transport = u.protocol === "https:" ? https : http;
  return new Promise<HelperCmdResult | null>((resolve) => {
    const req = transport.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(payload)),
          ...(token ? { "X-Internal-Token": token } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 400) return resolve(null);
          let raw: {
            exit_code?: number | null;
            stdout_tail?: string;
            stderr_tail?: string;
          } = {};
          try {
            raw = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          } catch {
            return resolve(null);
          }
          resolve({
            exitCode: typeof raw.exit_code === "number" ? raw.exit_code : 1,
            stdout: raw.stdout_tail ?? "",
            stderr: raw.stderr_tail ?? "",
          });
        });
        res.on("error", () => resolve(null));
      },
    );
    req.setTimeout(budgetMs + HTTP_SLACK_MS, () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.write(payload);
    req.end();
  });
}

/** The in-cluster BFF base URL a helper pod uses to call back (fetch the bundle). */
export function internalBffBaseUrl(): string {
  return (
    env.WORKFLOW_BUILDER_INTERNAL_URL ||
    env.WORKFLOW_BUILDER_URL ||
    "http://workflow-builder.workflow-builder.svc.cluster.local:3000"
  ).replace(/\/$/, "");
}
