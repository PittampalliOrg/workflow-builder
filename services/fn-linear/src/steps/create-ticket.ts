/**
 * Create Linear ticket step
 */
import type { LinearCredentials } from "../types.js";

const LINEAR_API_URL = "https://api.linear.app/graphql";

type LinearGraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

type TeamsQueryResponse = {
  teams: {
    nodes: Array<{ id: string; name: string }>;
  };
};

type CreateIssueMutationResponse = {
  issueCreate: {
    success: boolean;
    issue?: {
      id: string;
      title: string;
      url: string;
    };
  };
};

export type CreateTicketInput = {
  ticketTitle: string;
  ticketDescription: string;
};

export type CreateTicketResult =
  | { success: true; id: string; url: string; title: string }
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

export async function createTicketStep(
  input: CreateTicketInput,
  credentials: LinearCredentials
): Promise<CreateTicketResult> {
  const apiKey = credentials.LINEAR_API_KEY;
  const teamId = credentials.LINEAR_TEAM_ID;

  if (!apiKey) {
    return {
      success: false,
      error: "LINEAR_API_KEY is not configured. Please add it in Project Integrations.",
    };
  }

  try {
    let targetTeamId = teamId;

    if (!targetTeamId) {
      const teamsResult = await linearQuery<TeamsQueryResponse>(
        apiKey,
        `query { teams { nodes { id name } } }`
      );

      if (teamsResult.errors?.length) {
        return {
          success: false,
          error: teamsResult.errors[0].message,
        };
      }

      const firstTeam = teamsResult.data?.teams.nodes[0];
      if (!firstTeam) {
        return {
          success: false,
          error: "No teams found in Linear workspace",
        };
      }
      targetTeamId = firstTeam.id;
    }

    const createResult = await linearQuery<CreateIssueMutationResponse>(
      apiKey,
      `mutation CreateIssue($title: String!, $description: String, $teamId: String!) {
        issueCreate(input: { title: $title, description: $description, teamId: $teamId }) {
          success
          issue {
            id
            title
            url
          }
        }
      }`,
      {
        title: input.ticketTitle,
        description: input.ticketDescription,
        teamId: targetTeamId,
      }
    );

    if (createResult.errors?.length) {
      return {
        success: false,
        error: createResult.errors[0].message,
      };
    }

    const issue = createResult.data?.issueCreate.issue;
    if (!issue) {
      return {
        success: false,
        error: "Failed to create issue",
      };
    }

    return {
      success: true,
      id: issue.id,
      url: issue.url,
      title: issue.title,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to create ticket: ${message}`,
    };
  }
}
