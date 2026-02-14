/**
 * GET /api/secrets/available
 *
 * Returns a list of available infrastructure secrets from Dapr/Azure Key Vault.
 * Returns the known secret mappings. Actual secret availability is checked at
 * execution time by the function-router service.
 */

import { getSession } from "@/lib/auth-helpers";

/**
 * Mapping of secret keys to their integration types and labels.
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

export async function GET(request: Request) {
  // Require authentication
  const session = await getSession(request);

  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

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
    available: true,
    secretStoreConnected: true,
    secrets,
  } satisfies InfrastructureSecretsResponse);
}
