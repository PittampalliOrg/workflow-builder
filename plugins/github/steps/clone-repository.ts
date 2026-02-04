import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/lib/steps/step-handler";
import { getErrorMessage } from "@/lib/utils";
import type { GitHubCredentials } from "../credentials";

const GITHUB_API_URL = "https://api.github.com";

type CloneRepositoryResult =
  | {
      success: true;
      path: string;
      owner: string;
      repo: string;
      branch: string;
      url: string;
      message: string;
    }
  | { success: false; error: string };

export type CloneRepositoryCoreInput = {
  owner: string;
  repo: string;
  branch?: string;
  workspace_dir?: string;
};

export type CloneRepositoryInput = StepInput &
  CloneRepositoryCoreInput & {
    integrationId?: string;
    token?: string;
    // Credentials injected by activity-executor
    GITHUB_TOKEN?: string;
    _credentials?: GitHubCredentials;
  };

async function stepHandler(
  input: CloneRepositoryCoreInput & { token?: string },
  credentials: GitHubCredentials
): Promise<CloneRepositoryResult> {
  const token = credentials.GITHUB_TOKEN || input.token;
  const { owner, repo, branch = "main" } = input;

  if (!owner || !repo) {
    return {
      success: false,
      error: "Repository owner and name are required",
    };
  }

  try {
    // Verify the repository exists and is accessible
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    // Check repository exists
    const repoUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}`;
    const repoResponse = await fetch(repoUrl, {
      method: "GET",
      headers,
    });

    if (!repoResponse.ok) {
      if (repoResponse.status === 404) {
        return {
          success: false,
          error: `Repository ${owner}/${repo} not found or not accessible. ${token ? "" : "A GitHub token may be required for private repositories."}`,
        };
      }
      const errorData = (await repoResponse.json()) as { message?: string };
      return {
        success: false,
        error: errorData.message || `HTTP ${repoResponse.status}`,
      };
    }

    const repoData = (await repoResponse.json()) as {
      html_url: string;
      default_branch: string;
      private: boolean;
    };

    // For now, we return success with repository info
    // In a full implementation, this would download and extract the tarball
    // The planner-dapr-agent would have git installed for actual cloning
    const targetBranch = branch || repoData.default_branch;
    const workspaceDir = input.workspace_dir || `/app/workspace/${owner}/${repo}`;

    return {
      success: true,
      path: workspaceDir,
      owner,
      repo,
      branch: targetBranch,
      url: repoData.html_url,
      message: `Repository ${owner}/${repo} verified. Branch: ${targetBranch}. ${repoData.private ? "Private repository." : "Public repository."} Workspace: ${workspaceDir}`,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to clone repository: ${getErrorMessage(error)}`,
    };
  }
}

export async function cloneRepositoryStep(
  input: CloneRepositoryInput
): Promise<CloneRepositoryResult> {
  "use step";

  // Use credentials injected by activity-executor first (from Dapr secrets)
  // Fall back to fetching from database if not available
  let credentials: GitHubCredentials = {};

  if (input.GITHUB_TOKEN || input._credentials?.GITHUB_TOKEN) {
    credentials = {
      GITHUB_TOKEN: input.GITHUB_TOKEN || input._credentials?.GITHUB_TOKEN,
    };
  } else if (input.token) {
    credentials = {
      GITHUB_TOKEN: input.token,
    };
  } else if (input.integrationId) {
    credentials = await fetchCredentials(input.integrationId);
  }

  return withStepLogging(input, () => stepHandler(input, credentials));
}
cloneRepositoryStep.maxRetries = 0;

export const _integrationType = "github";
