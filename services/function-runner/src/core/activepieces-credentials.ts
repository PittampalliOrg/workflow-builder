/**
 * ActivePieces Credential Mapper for Function Runner
 *
 * Maps credentials from workflow-builder format to ActivePieces format.
 * This file is a lightweight copy of the lib/activepieces/credential-mapper.ts
 * to avoid importing from the main package in the function-runner service.
 */

import type { WorkflowCredentials } from "./types.js";

/**
 * ActivePieces auth structure varies by piece
 */
export type ActivePiecesAuth = Record<string, unknown>;

/**
 * Authentication type used by AP pieces
 */
type AuthenticationType =
  | "API_KEY"
  | "BASIC"
  | "BEARER_TOKEN"
  | "OAUTH2"
  | "CUSTOM_AUTH"
  | "SECRET_TEXT"
  | "NONE";

/**
 * Credential mapping configuration
 */
interface CredentialMapperConfig {
  authType: AuthenticationType;
  mapping: Record<string, string>;
  transform?: (creds: WorkflowCredentials) => ActivePiecesAuth;
}

/**
 * Credential mappers for ActivePieces pieces
 * Maps our env var names to AP auth field names
 */
const AP_CREDENTIAL_MAPPERS: Record<string, CredentialMapperConfig> = {
  // Communication
  slack: {
    authType: "OAUTH2",
    mapping: { SLACK_BOT_TOKEN: "access_token" },
    transform: (creds) => ({
      access_token: creds.SLACK_BOT_TOKEN,
      data: {
        team: { id: creds.SLACK_TEAM_ID, name: creds.SLACK_TEAM_NAME },
      },
    }),
  },
  discord: {
    authType: "BEARER_TOKEN",
    mapping: { DISCORD_BOT_TOKEN: "token" },
  },
  telegram: {
    authType: "CUSTOM_AUTH",
    mapping: { TELEGRAM_BOT_TOKEN: "bot_token" },
  },
  twilio: {
    authType: "CUSTOM_AUTH",
    mapping: {
      TWILIO_ACCOUNT_SID: "account_sid",
      TWILIO_AUTH_TOKEN: "auth_token",
    },
  },
  "microsoft-teams": {
    authType: "OAUTH2",
    mapping: {
      MICROSOFT_ACCESS_TOKEN: "access_token",
      MICROSOFT_REFRESH_TOKEN: "refresh_token",
    },
  },

  // Google Suite (shared OAuth)
  gmail: {
    authType: "OAUTH2",
    mapping: {
      GOOGLE_ACCESS_TOKEN: "access_token",
      GOOGLE_REFRESH_TOKEN: "refresh_token",
    },
  },
  "google-sheets": {
    authType: "OAUTH2",
    mapping: {
      GOOGLE_ACCESS_TOKEN: "access_token",
      GOOGLE_REFRESH_TOKEN: "refresh_token",
    },
  },
  "google-drive": {
    authType: "OAUTH2",
    mapping: {
      GOOGLE_ACCESS_TOKEN: "access_token",
      GOOGLE_REFRESH_TOKEN: "refresh_token",
    },
  },
  "google-calendar": {
    authType: "OAUTH2",
    mapping: {
      GOOGLE_ACCESS_TOKEN: "access_token",
      GOOGLE_REFRESH_TOKEN: "refresh_token",
    },
  },
  "google-docs": {
    authType: "OAUTH2",
    mapping: {
      GOOGLE_ACCESS_TOKEN: "access_token",
      GOOGLE_REFRESH_TOKEN: "refresh_token",
    },
  },

  // Productivity
  notion: {
    authType: "OAUTH2",
    mapping: { NOTION_ACCESS_TOKEN: "access_token" },
  },
  airtable: {
    authType: "OAUTH2",
    mapping: { AIRTABLE_ACCESS_TOKEN: "access_token" },
  },
  asana: {
    authType: "OAUTH2",
    mapping: { ASANA_ACCESS_TOKEN: "access_token" },
  },
  todoist: {
    authType: "OAUTH2",
    mapping: { TODOIST_ACCESS_TOKEN: "access_token" },
  },
  trello: {
    authType: "CUSTOM_AUTH",
    mapping: { TRELLO_API_KEY: "api_key", TRELLO_TOKEN: "token" },
  },
  clickup: {
    authType: "OAUTH2",
    mapping: { CLICKUP_ACCESS_TOKEN: "access_token" },
  },

  // CRM / Marketing
  hubspot: {
    authType: "OAUTH2",
    mapping: {
      HUBSPOT_ACCESS_TOKEN: "access_token",
      HUBSPOT_REFRESH_TOKEN: "refresh_token",
    },
  },
  salesforce: {
    authType: "OAUTH2",
    mapping: {
      SALESFORCE_ACCESS_TOKEN: "access_token",
      SALESFORCE_REFRESH_TOKEN: "refresh_token",
      SALESFORCE_INSTANCE_URL: "instance_url",
    },
  },
  mailchimp: {
    authType: "OAUTH2",
    mapping: {
      MAILCHIMP_ACCESS_TOKEN: "access_token",
      MAILCHIMP_SERVER_PREFIX: "server_prefix",
    },
  },
  sendgrid: {
    authType: "API_KEY",
    mapping: { SENDGRID_API_KEY: "api_key" },
  },
  intercom: {
    authType: "OAUTH2",
    mapping: { INTERCOM_ACCESS_TOKEN: "access_token" },
  },

  // Developer Tools
  github: {
    authType: "OAUTH2",
    mapping: { GITHUB_TOKEN: "access_token" },
  },
  gitlab: {
    authType: "OAUTH2",
    mapping: { GITLAB_ACCESS_TOKEN: "access_token" },
  },
  "jira-cloud": {
    authType: "OAUTH2",
    mapping: {
      JIRA_ACCESS_TOKEN: "access_token",
      JIRA_REFRESH_TOKEN: "refresh_token",
      JIRA_CLOUD_ID: "cloud_id",
    },
  },
  linear: {
    authType: "OAUTH2",
    mapping: { LINEAR_API_KEY: "api_key" },
  },
  sentry: {
    authType: "API_KEY",
    mapping: { SENTRY_AUTH_TOKEN: "auth_token" },
  },

  // Storage
  dropbox: {
    authType: "OAUTH2",
    mapping: {
      DROPBOX_ACCESS_TOKEN: "access_token",
      DROPBOX_REFRESH_TOKEN: "refresh_token",
    },
  },
  onedrive: {
    authType: "OAUTH2",
    mapping: {
      MICROSOFT_ACCESS_TOKEN: "access_token",
      MICROSOFT_REFRESH_TOKEN: "refresh_token",
    },
  },
  box: {
    authType: "OAUTH2",
    mapping: {
      BOX_ACCESS_TOKEN: "access_token",
      BOX_REFRESH_TOKEN: "refresh_token",
    },
  },

  // Finance
  stripe: {
    authType: "API_KEY",
    mapping: { STRIPE_SECRET_KEY: "api_key" },
  },
  quickbooks: {
    authType: "OAUTH2",
    mapping: {
      QUICKBOOKS_ACCESS_TOKEN: "access_token",
      QUICKBOOKS_REFRESH_TOKEN: "refresh_token",
      QUICKBOOKS_REALM_ID: "realm_id",
    },
  },

  // E-commerce
  shopify: {
    authType: "CUSTOM_AUTH",
    mapping: {
      SHOPIFY_ACCESS_TOKEN: "access_token",
      SHOPIFY_SHOP: "shop",
    },
  },
  woocommerce: {
    authType: "CUSTOM_AUTH",
    mapping: {
      WOOCOMMERCE_CONSUMER_KEY: "consumer_key",
      WOOCOMMERCE_CONSUMER_SECRET: "consumer_secret",
      WOOCOMMERCE_STORE_URL: "store_url",
    },
  },

  // Support
  zendesk: {
    authType: "OAUTH2",
    mapping: {
      ZENDESK_ACCESS_TOKEN: "access_token",
      ZENDESK_SUBDOMAIN: "subdomain",
    },
  },
  freshdesk: {
    authType: "API_KEY",
    mapping: {
      FRESHDESK_API_KEY: "api_key",
      FRESHDESK_DOMAIN: "domain",
    },
  },

  // Social
  twitter: {
    authType: "OAUTH2",
    mapping: {
      TWITTER_ACCESS_TOKEN: "access_token",
      TWITTER_ACCESS_TOKEN_SECRET: "access_token_secret",
    },
  },
  "facebook-pages": {
    authType: "OAUTH2",
    mapping: {
      FACEBOOK_ACCESS_TOKEN: "access_token",
      FACEBOOK_PAGE_ID: "page_id",
    },
  },
  linkedin: {
    authType: "OAUTH2",
    mapping: { LINKEDIN_ACCESS_TOKEN: "access_token" },
  },

  // AI
  openai: {
    authType: "API_KEY",
    mapping: { OPENAI_API_KEY: "api_key" },
  },

  // Generic (no auth)
  http: { authType: "NONE", mapping: {} },
  webhook: { authType: "NONE", mapping: {} },
};

/**
 * Map workflow-builder credentials to ActivePieces auth format
 *
 * @param pieceName - Name of the AP piece (e.g., "slack", "github")
 * @param credentials - Credentials in our format (env var names)
 * @returns ActivePieces auth payload
 */
export function mapCredentialsToActivePieces(
  pieceName: string,
  credentials: WorkflowCredentials
): ActivePiecesAuth {
  const config = AP_CREDENTIAL_MAPPERS[pieceName];

  if (!config) {
    // No mapper - pass credentials as-is (piece may not require auth)
    console.warn(
      `[AP Credential Mapper] No mapper for piece: ${pieceName}, passing credentials as-is`
    );
    return credentials as ActivePiecesAuth;
  }

  // Use custom transform if provided
  if (config.transform) {
    return config.transform(credentials);
  }

  // Default: apply simple field mapping
  const auth: ActivePiecesAuth = {};

  for (const [ourKey, apKey] of Object.entries(config.mapping)) {
    const value = credentials[ourKey];
    if (value !== undefined) {
      auth[apKey] = value;
    }
  }

  return auth;
}

/**
 * Check if a function slug is an ActivePieces function
 * AP functions have the format: ap-{pieceName}/{actionName}
 */
export function isActivePiecesFunction(slug: string): boolean {
  return slug.startsWith("ap-");
}

/**
 * Extract piece name from an AP function slug
 * e.g., "ap-slack/send_message" -> "slack"
 */
export function extractPieceNameFromSlug(slug: string): string | null {
  if (!isActivePiecesFunction(slug)) {
    return null;
  }

  const match = slug.match(/^ap-([^/]+)\//);
  return match ? match[1] : null;
}
