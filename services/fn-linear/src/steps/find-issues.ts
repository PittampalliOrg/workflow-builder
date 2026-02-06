/**
 * Find Linear issues step
 */
import type { LinearCredentials } from "../types.js";

const LINEAR_API_URL = "https://api.linear.app/graphql";

type LinearGraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

type IssuesQueryResponse = {
  issues: {
    nodes: Array<{
      id: string;
      title: string;
      url: string;
      priority: number;
      assignee?: {
        id: string;
      };
      state: {
        name: string;
      } | null;
    }>;
  };
};

type LinearIssue = {
  id: string;
  title: string;
  url: string;
  state: string;
  priority: number;
  assigneeId?: string;
};

export type FindIssuesInput = {
  linearAssigneeId?: string;
  linearTeamId?: string;
  linearStatus?: string;
  linearLabel?: string;
};

export type FindIssuesResult =
  | { success: true; issues: LinearIssue[]; count: number }
  | { success: false; error: string };

async function linearQuery<T>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<LinearGraphQLResponse<T>> {
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Linear API error: HTTP ${response.status}`);
  }

  return response.json() as Promise<LinearGraphQLResponse<T>>;
}

export async function findIssuesStep(
  input: FindIssuesInput,
  credentials: LinearCredentials
): Promise<FindIssuesResult> {
  const apiKey = credentials.LINEAR_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error: "LINEAR_API_KEY is not configured. Please add it in Project Integrations.",
    };
  }

  try {
    const filter: Record<string, unknown> = {};

    if (input.linearAssigneeId) {
      filter.assignee = { id: { eq: input.linearAssigneeId } };
    }

    if (input.linearTeamId) {
      filter.team = { id: { eq: input.linearTeamId } };
    }

    if (input.linearStatus && input.linearStatus !== "any") {
      filter.state = { name: { eqIgnoreCase: input.linearStatus } };
    }

    if (input.linearLabel) {
      filter.labels = { name: { eqIgnoreCase: input.linearLabel } };
    }

    const result = await linearQuery<IssuesQueryResponse>(
      apiKey,
      `query FindIssues($filter: IssueFilter) {
        issues(filter: $filter) {
          nodes {
            id
            title
            url
            priority
            assignee {
              id
            }
            state {
              name
            }
          }
        }
      }`,
      { filter: Object.keys(filter).length > 0 ? filter : undefined }
    );

    if (result.errors?.length) {
      return {
        success: false,
        error: result.errors[0].message,
      };
    }

    const mappedIssues: LinearIssue[] = (result.data?.issues.nodes || []).map((issue) => ({
      id: issue.id,
      title: issue.title,
      url: issue.url,
      state: issue.state?.name || "Unknown",
      priority: issue.priority,
      assigneeId: issue.assignee?.id || undefined,
    }));

    return {
      success: true,
      issues: mappedIssues,
      count: mappedIssues.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to find issues: ${message}`,
    };
  }
}
