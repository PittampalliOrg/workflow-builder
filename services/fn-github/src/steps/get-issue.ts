/**
 * Get GitHub issue step
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
  user: { login: string };
  created_at: string;
  updated_at: string;
  closed_at?: string;
  comments: number;
};

export type GetIssueInput = {
  owner: string;
  repo: string;
  issueNumber: string;
};

export type GetIssueResult =
  | {
      success: true;
      id: number;
      number: number;
      title: string;
      url: string;
      state: string;
      body?: string;
      labels: string[];
      assignees: string[];
      author: string;
      createdAt: string;
      updatedAt: string;
      closedAt?: string;
      commentsCount: number;
    }
  | { success: false; error: string };

export async function getIssueStep(
  input: GetIssueInput,
  credentials: GitHubCredentials
): Promise<GetIssueResult> {
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

    const response = await fetch(
      `${GITHUB_API_URL}/repos/${input.owner}/${input.repo}/issues/${issueNum}`,
      {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
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
      body: issue.body,
      labels: issue.labels.map((l) => l.name),
      assignees: issue.assignees.map((a) => a.login),
      author: issue.user.login,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      closedAt: issue.closed_at,
      commentsCount: issue.comments,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to get issue: ${message}`,
    };
  }
}
