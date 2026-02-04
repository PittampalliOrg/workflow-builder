import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/lib/steps/step-handler";
import { getErrorMessage } from "@/lib/utils";
import type { GitHubCredentials } from "../credentials";

const GITHUB_API_URL = "https://api.github.com";

type GitHubIssue = {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: string;
};

type UpdateIssueResult =
  | {
      success: true;
      id: number;
      number: number;
      title: string;
      url: string;
      state: string;
    }
  | { success: false; error: string };

export type UpdateIssueCoreInput = {
  owner: string;
  repo: string;
  issueNumber: string;
  title?: string;
  body?: string;
  state?: string;
  labels?: string;
  assignees?: string;
};

export type UpdateIssueInput = StepInput &
  UpdateIssueCoreInput & {
    integrationId?: string;
    // Credentials injected by activity-executor
    GITHUB_TOKEN?: string;
    _credentials?: GitHubCredentials;
  };

function parseCommaSeparated(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function stepHandler(
  input: UpdateIssueCoreInput,
  credentials: GitHubCredentials
): Promise<UpdateIssueResult> {
  const token = credentials.GITHUB_TOKEN;

  if (!token) {
    return {
      success: false,
      error:
        "GITHUB_TOKEN is not configured. Please add it in Project Integrations.",
    };
  }

  try {
    const issueNum = Number.parseInt(input.issueNumber, 10);
    if (Number.isNaN(issueNum)) {
      return {
        success: false,
        error: "Invalid issue number",
      };
    }

    const body: Record<string, unknown> = {};

    if (input.title) {
      body.title = input.title;
    }

    if (input.body) {
      body.body = input.body;
    }

    if (input.state && input.state !== "") {
      body.state = input.state;
    }

    if (input.labels !== undefined) {
      const labels = parseCommaSeparated(input.labels);
      body.labels = labels;
    }

    if (input.assignees !== undefined) {
      const assignees = parseCommaSeparated(input.assignees);
      body.assignees = assignees;
    }

    if (Object.keys(body).length === 0) {
      return {
        success: false,
        error: "No fields to update. Please provide at least one field.",
      };
    }

    const response = await fetch(
      `${GITHUB_API_URL}/repos/${input.owner}/${input.repo}/issues/${issueNum}`,
      {
        method: "PATCH",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const errorData = (await response.json()) as { message?: string };
      return {
        success: false,
        error: errorData.message || `HTTP ${response.status}`,
      };
    }

    const issue = (await response.json()) as GitHubIssue;

    return {
      success: true,
      id: issue.id,
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      state: issue.state,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to update issue: ${getErrorMessage(error)}`,
    };
  }
}

export async function updateIssueStep(
  input: UpdateIssueInput
): Promise<UpdateIssueResult> {
  "use step";

  // Use credentials injected by activity-executor first (from Dapr secrets)
  // Fall back to fetching from database if not available
  let credentials: GitHubCredentials = {};

  if (input.GITHUB_TOKEN || input._credentials?.GITHUB_TOKEN) {
    // Use injected credentials from activity-executor
    credentials = {
      GITHUB_TOKEN: input.GITHUB_TOKEN || input._credentials?.GITHUB_TOKEN,
    };
  } else if (input.integrationId) {
    // Fall back to database lookup (for Next.js context)
    credentials = await fetchCredentials(input.integrationId);
  }

  return withStepLogging(input, () => stepHandler(input, credentials));
}
updateIssueStep.maxRetries = 0;

export const _integrationType = "github";

