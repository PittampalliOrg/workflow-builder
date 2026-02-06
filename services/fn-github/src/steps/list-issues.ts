/**
 * List GitHub issues step
 */
import type { GitHubCredentials } from "../types.js";

const GITHUB_API_URL = "https://api.github.com";

type GitHubIssue = {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: string;
  body?: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  created_at: string;
  updated_at: string;
};

export type ListIssuesInput = {
  owner: string;
  repo: string;
  state?: string;
  labels?: string;
  assignee?: string;
  perPage?: number;
};

export type ListIssuesResult =
  | {
      success: true;
      issues: Array<{
        id: number;
        number: number;
        title: string;
        url: string;
        state: string;
        body?: string;
        labels: string[];
        assignees: string[];
        createdAt: string;
        updatedAt: string;
      }>;
      count: number;
    }
  | { success: false; error: string };

export async function listIssuesStep(
  input: ListIssuesInput,
  credentials: GitHubCredentials
): Promise<ListIssuesResult> {
  const token = credentials.GITHUB_TOKEN;

  if (!token) {
    return {
      success: false,
      error: "GITHUB_TOKEN is not configured. Please add it in Project Integrations.",
    };
  }

  try {
    const params = new URLSearchParams();

    if (input.state && input.state !== "open") {
      params.set("state", input.state);
    }

    if (input.labels) {
      params.set("labels", input.labels);
    }

    if (input.assignee) {
      params.set("assignee", input.assignee);
    }

    if (input.perPage) {
      params.set("per_page", String(input.perPage));
    }

    const url = `${GITHUB_API_URL}/repos/${input.owner}/${input.repo}/issues${
      params.toString() ? `?${params.toString()}` : ""
    }`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      const errorData = (await response.json()) as { message?: string };
      return {
        success: false,
        error: errorData.message || `HTTP ${response.status}`,
      };
    }

    const rawIssues = (await response.json()) as GitHubIssue[];

    const issues = rawIssues.map((issue) => ({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      state: issue.state,
      body: issue.body,
      labels: issue.labels.map((l) => l.name),
      assignees: issue.assignees.map((a) => a.login),
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
    }));

    return {
      success: true,
      issues,
      count: issues.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to list issues: ${message}`,
    };
  }
}
