import { env } from "$env/dynamic/private";
import { daprFetch } from "$lib/server/dapr-client";
import type {
  ArmWorkspaceRetentionInput,
  WorkspaceRetentionAcknowledgement,
  WorkspaceRetentionPort,
} from "$lib/server/application/ports/workspace-retention";

type Fetcher = (
  input: string,
  init?: RequestInit & { maxRetries?: number },
) => Promise<Response>;

export type HttpWorkspaceRetentionAdapterOptions = {
  baseUrl: string;
  fetcher?: Fetcher;
};

/** HTTP adapter for the provider that owns Agent Sandbox retention state. */
export class HttpWorkspaceRetentionAdapter implements WorkspaceRetentionPort {
  private readonly baseUrl: string;
  private readonly fetcher: Fetcher;

  constructor(options: HttpWorkspaceRetentionAdapterOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    if (!this.baseUrl) {
      throw new Error("workspace retention provider URL is required");
    }
    this.fetcher = options.fetcher ?? daprFetch;
  }

  async armTerminalRetention(
    input: ArmWorkspaceRetentionInput,
  ): Promise<WorkspaceRetentionAcknowledgement> {
    const executionId = input.identity.durableExecutionId.trim();
    const dbExecutionId = input.identity.databaseExecutionId?.trim() || "";
    if (!executionId && !dbExecutionId) {
      throw new Error("workspace retention requires durable or database identity");
    }
    if (Number.isNaN(input.terminalAt.getTime())) {
      throw new Error("workspace retention terminalAt must be valid");
    }

    const response = await this.fetcher(
      `${this.baseUrl}/api/workspaces/retain`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executionId,
          dbExecutionId,
          terminalAt: input.terminalAt.toISOString(),
        }),
        maxRetries: 0,
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `workspace retention provider failed (${response.status})${text ? `: ${text.slice(0, 1_200)}` : ""}`,
      );
    }

    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new Error("workspace retention provider returned invalid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("workspace retention provider returned an invalid acknowledgement");
    }
    const acknowledgement = body as Record<string, unknown>;
    if (acknowledgement.success === false) {
      const detail = String(
        acknowledgement.error ?? acknowledgement.message ?? "semantic rejection",
      );
      throw new Error(`workspace retention provider rejected the request: ${detail}`);
    }
    const results = acknowledgement.results;
    if (acknowledgement.success !== true && !Array.isArray(results)) {
      throw new Error(
        "workspace retention provider returned no positive acknowledgement",
      );
    }
    return {
      terminalAt:
        typeof acknowledgement.terminalAt === "string"
          ? acknowledgement.terminalAt
          : null,
      resultCount: Array.isArray(results) ? results.length : 0,
    };
  }
}

export function configuredWorkspaceRetentionPort(): WorkspaceRetentionPort | null {
  const baseUrl = (
    env.WORKSPACE_RETENTION_URL ??
    process.env.WORKSPACE_RETENTION_URL ??
    ""
  ).trim();
  return baseUrl ? new HttpWorkspaceRetentionAdapter({ baseUrl }) : null;
}
