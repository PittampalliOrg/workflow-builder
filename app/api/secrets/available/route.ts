/**
 * GET /api/secrets/available
 *
 * Returns a list of available infrastructure secrets from Dapr/Azure Key Vault.
 * This endpoint checks the activity-executor's status to determine if secrets are available,
 * then returns the known secret mappings.
 */

import { getSession } from "@/lib/auth-helpers";

/**
 * Mapping of secret keys to their integration types and labels.
 * Matches the SECRET_MAPPINGS in activity-executor/src/core/credential-service.ts
 */
const SECRET_INTEGRATION_MAP: Record<
  string,
  { type: string; label: string; envVar: string }
> = {
  "OPENAI-API-KEY": {
    type: "openai",
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
  },
  "ANTHROPIC-API-KEY": {
    type: "anthropic",
    label: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
  },
  "GITHUB-TOKEN": { type: "github", label: "GitHub", envVar: "GITHUB_TOKEN" },
  "SLACK-BOT-TOKEN": {
    type: "slack",
    label: "Slack",
    envVar: "SLACK_BOT_TOKEN",
  },
  "RESEND-API-KEY": {
    type: "resend",
    label: "Resend",
    envVar: "RESEND_API_KEY",
  },
  "LINEAR-API-KEY": {
    type: "linear",
    label: "Linear",
    envVar: "LINEAR_API_KEY",
  },
  "STRIPE-SECRET-KEY": {
    type: "stripe",
    label: "Stripe",
    envVar: "STRIPE_SECRET_KEY",
  },
  "FIRECRAWL-API-KEY": {
    type: "firecrawl",
    label: "Firecrawl",
    envVar: "FIRECRAWL_API_KEY",
  },
  "PERPLEXITY-API-KEY": {
    type: "perplexity",
    label: "Perplexity",
    envVar: "PERPLEXITY_API_KEY",
  },
  "CLERK-SECRET-KEY": {
    type: "clerk",
    label: "Clerk",
    envVar: "CLERK_SECRET_KEY",
  },
  "FAL-API-KEY": { type: "fal", label: "fal.ai", envVar: "FAL_KEY" },
  "WEBFLOW-API-TOKEN": {
    type: "webflow",
    label: "Webflow",
    envVar: "WEBFLOW_API_TOKEN",
  },
  "SUPERAGENT-API-KEY": {
    type: "superagent",
    label: "Superagent",
    envVar: "SUPERAGENT_API_KEY",
  },
};

/**
 * Activity executor URL for status checks
 * Uses full cluster DNS name since services are in different namespaces
 */
const ACTIVITY_EXECUTOR_URL =
  process.env.ACTIVITY_EXECUTOR_URL ||
  "http://activity-executor.activity-executor.svc.cluster.local:8080";

export type InfrastructureSecret = {
  key: string;
  integrationType: string;
  label: string;
  envVar: string;
  source: "azure-keyvault";
};

export type InfrastructureSecretsResponse = {
  available: boolean;
  secretStoreConnected: boolean;
  secrets: InfrastructureSecret[];
};

/**
 * Check activity-executor status to see if Dapr secret store is connected
 */
async function checkSecretStoreStatus(): Promise<{
  available: boolean;
  connected: boolean;
}> {
  try {
    // Use a longer timeout as DNS resolution in k8s can be slow
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    const response = await fetch(`${ACTIVITY_EXECUTOR_URL}/status`, {
      signal: controller.signal,
      // Disable keep-alive to avoid connection pooling issues
      headers: { Connection: "close" },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { available: false, connected: false };
    }

    const status = (await response.json()) as {
      components?: {
        dapr?: {
          secretStore?: {
            available?: boolean;
          };
        };
      };
    };

    const secretStoreAvailable =
      status?.components?.dapr?.secretStore?.available ?? false;

    return {
      available: true,
      connected: secretStoreAvailable,
    };
  } catch (error) {
    console.warn(
      "[Secrets API] Failed to check activity-executor status:",
      error
    );
    return { available: false, connected: false };
  }
}

export async function GET(request: Request) {
  // Require authentication
  const session = await getSession(request);

  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check secret store status
  const { available, connected } = await checkSecretStoreStatus();

  // Build list of available secrets
  const secrets: InfrastructureSecret[] = Object.entries(
    SECRET_INTEGRATION_MAP
  ).map(([key, { type, label, envVar }]) => ({
    key,
    integrationType: type,
    label,
    envVar,
    source: "azure-keyvault" as const,
  }));

  return Response.json({
    available,
    secretStoreConnected: connected,
    secrets,
  } satisfies InfrastructureSecretsResponse);
}
