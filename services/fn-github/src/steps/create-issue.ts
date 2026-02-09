/**
 * Create GitHub issue step
 */
import type { GitHubCredentials } from "../types.js";

const GITHUB_API_URL = "https://api.github.com";

type GitHubIssue = {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: string;
};

export type CreateIssueInput = {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  labels?: string;
  assignees?: string;
};

export type CreateIssueResult =
  | {
      success: true;
      id: number;
      number: number;
      title: string;
      url: string;
      state: string;
    }
  | { success: false; error: string };

function parseCommaSeparated(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function createIssueStep(
  input: CreateIssueInput,
  credentials: GitHubCredentials
): Promise<CreateIssueResult> {
  const token = credentials.GITHUB_TOKEN;

  if (!token) {
    return {
      success: false,
      error:
        "GITHUB_TOKEN is not configured. Please add it in Project Integrations.",
    };
  }

  try {
    const body: Record<string, unknown> = {
      title: input.title,
    };

    if (input.body) {
      body.body = input.body;
    }

    const labels = parseCommaSeparated(input.labels);
    if (labels.length > 0) {
      body.labels = labels;
    }

    const assignees = parseCommaSeparated(input.assignees);
    if (assignees.length > 0) {
      body.assignees = assignees;
    }

    const response = await fetch(
      `${GITHUB_API_URL}/repos/${input.owner}/${input.repo}/issues`,
      {
        method: "POST",
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
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to create issue: ${message}`,
    };
  }
}
