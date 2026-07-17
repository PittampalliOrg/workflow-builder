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
import {
  deleteCliStorageForSession,
  deleteKubernetesSandbox,
  waitForKubernetesSandboxDeleted,
} from "$lib/server/kube/client";
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

/** Delete the helper Sandbox CR after the fixed helper command has completed. */
export async function cleanupWorkspaceHelperPod(
  helper: {
    sandboxName?: string | null;
    helperSessionId?: string | null;
  } | null,
): Promise<"deleted" | "missing" | "skipped" | "failed"> {
  const explicitSandboxName = helper?.sandboxName?.trim();
  const helperSessionId = helper?.helperSessionId?.trim();
  const sandboxName =
    explicitSandboxName ||
    (helperSessionId ? `agent-host-${sessionHostAppId(helperSessionId)}` : null);
  if (!sandboxName && !helperSessionId) return "skipped";
  let sandboxStatus: "deleted" | "missing" | "skipped" = "skipped";
  try {
    if (sandboxName) {
      sandboxStatus = await deleteKubernetesSandbox(sandboxName);
      const waitStatus = await waitForKubernetesSandboxDeleted(sandboxName);
      if (waitStatus !== "deleted") {
        throw new Error(
          `sandbox ${sandboxName} did not terminate before storage cleanup`,
        );
      }
    }
    if (helperSessionId) {
      await deleteCliStorageForSession(helperSessionId);
    }
    return sandboxStatus;
  } catch (err) {
    console.warn(
      `[helper-pod] cleanup failed for ${sandboxName ?? helperSessionId}:`,
      err instanceof Error ? err.message : err,
    );
    return "failed";
  }
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
