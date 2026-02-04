/**
 * ActivePieces Integration Types
 *
 * Type definitions for interacting with ActivePieces pieces via HTTP.
 * These types align with the ActivePieces SDK data structures.
 */

/**
 * Authentication types supported by ActivePieces pieces
 */
export type AuthenticationType =
  | "API_KEY"
  | "BASIC"
  | "BEARER_TOKEN"
  | "OAUTH2"
  | "CUSTOM_AUTH"
  | "SECRET_TEXT"
  | "NONE";

/**
 * Property types for piece action inputs
 */
export type PropertyType =
  | "SHORT_TEXT"
  | "LONG_TEXT"
  | "MARKDOWN"
  | "NUMBER"
  | "CHECKBOX"
  | "STATIC_DROPDOWN"
  | "STATIC_MULTI_SELECT_DROPDOWN"
  | "DYNAMIC_DROPDOWN"
  | "MULTI_SELECT_DROPDOWN"
  | "ARRAY"
  | "OBJECT"
  | "JSON"
  | "DATE_TIME"
  | "FILE";

/**
 * Dropdown option for static/dynamic selects
 */
export interface DropdownOption {
  label: string;
  value: string | number | boolean;
}

/**
 * Property definition for piece action inputs
 */
export interface PieceProperty {
  displayName: string;
  description?: string;
  type: PropertyType;
  required: boolean;
  defaultValue?: unknown;
  options?: DropdownOption[];
  // For dynamic dropdowns - refresh function name
  refreshers?: string[];
}

/**
 * ActivePieces piece authentication definition
 */
export interface PieceAuth {
  type: AuthenticationType;
  displayName: string;
  description?: string;
  required: boolean;
  props?: Record<string, PieceProperty>;
}

/**
 * Piece action definition
 */
export interface PieceAction {
  name: string;
  displayName: string;
  description: string;
  props: Record<string, PieceProperty>;
  // Whether this action requires authentication
  requireAuth: boolean;
}

/**
 * Piece trigger definition (for completeness, though we focus on actions)
 */
export interface PieceTrigger {
  name: string;
  displayName: string;
  description: string;
  props: Record<string, PieceProperty>;
  type: "POLLING" | "WEBHOOK";
  requireAuth: boolean;
}

/**
 * Complete piece metadata
 */
export interface PieceMetadata {
  name: string;
  displayName: string;
  description: string;
  logoUrl: string;
  version: string;
  minimumSupportedRelease?: string;
  maximumSupportedRelease?: string;
  auth?: PieceAuth;
  actions: Record<string, PieceAction>;
  triggers?: Record<string, PieceTrigger>;
  // Categories for organization (e.g., "COMMUNICATION", "PRODUCTIVITY")
  categories?: string[];
  // Package name (e.g., "@activepieces/piece-slack")
  packageName?: string;
}

/**
 * Piece execution request sent to ActivePieces
 */
export interface PieceExecutionRequest {
  // The piece name (e.g., "slack", "google-sheets")
  pieceName: string;
  // The piece version (e.g., "0.3.0")
  pieceVersion: string;
  // The action name (e.g., "send_message", "append_row")
  actionName: string;
  // Action input values
  input: Record<string, unknown>;
  // Authentication credentials
  auth?: Record<string, unknown>;
  // Server URL for OAuth refresh if needed
  serverUrl?: string;
}

/**
 * Piece execution response from ActivePieces
 */
export interface PieceExecutionResponse {
  success: boolean;
  output?: unknown;
  error?: {
    message: string;
    code?: string;
    details?: unknown;
  };
  // Execution metadata
  duration?: number;
}

/**
 * Simplified piece summary for listing/discovery
 */
export interface PieceSummary {
  name: string;
  displayName: string;
  description: string;
  logoUrl: string;
  version: string;
  categories?: string[];
  actionCount: number;
  triggerCount: number;
}

/**
 * Mapping from AP auth type to our credential format
 */
export interface CredentialMapping {
  // AP auth field name -> our credential env var name
  [apFieldName: string]: string;
}

/**
 * Popular pieces we want to seed initially
 * These are high-value integrations with good OAuth support
 */
export const POPULAR_PIECES = [
  // Google Suite
  "gmail",
  "google-sheets",
  "google-drive",
  "google-calendar",
  "google-docs",

  // Productivity
  "notion",
  "airtable",
  "asana",
  "todoist",
  "trello",
  "clickup",

  // CRM / Marketing
  "hubspot",
  "salesforce",
  "mailchimp",
  "sendgrid",
  "intercom",

  // Communication
  "slack",
  "discord",
  "telegram",
  "microsoft-teams",
  "twilio",

  // Developer
  "github",
  "gitlab",
  "jira-cloud",
  "linear",
  "sentry",

  // Data / Storage
  "dropbox",
  "onedrive",
  "box",

  // Finance
  "stripe",
  "quickbooks",

  // E-commerce
  "shopify",
  "woocommerce",

  // Support
  "zendesk",
  "freshdesk",

  // Social
  "twitter",
  "facebook-pages",
  "linkedin",

  // AI
  "openai",

  // Misc
  "webhook",
  "http",
] as const;

export type PopularPieceName = (typeof POPULAR_PIECES)[number];

/**
 * Convert AP property type to JSON Schema type
 */
export function apPropertyTypeToJsonSchema(
  prop: PieceProperty
): Record<string, unknown> {
  const schema: Record<string, unknown> = {};

  switch (prop.type) {
    case "SHORT_TEXT":
    case "LONG_TEXT":
    case "MARKDOWN":
    case "DATE_TIME":
      schema.type = "string";
      break;
    case "NUMBER":
      schema.type = "number";
      break;
    case "CHECKBOX":
      schema.type = "boolean";
      break;
    case "STATIC_DROPDOWN":
    case "DYNAMIC_DROPDOWN":
      schema.type = "string";
      if (prop.options && prop.options.length > 0) {
        schema.enum = prop.options.map((o) => o.value);
      }
      break;
    case "STATIC_MULTI_SELECT_DROPDOWN":
    case "MULTI_SELECT_DROPDOWN":
      schema.type = "array";
      schema.items = { type: "string" };
      if (prop.options && prop.options.length > 0) {
        (schema.items as Record<string, unknown>).enum = prop.options.map(
          (o) => o.value
        );
      }
      break;
    case "ARRAY":
      schema.type = "array";
      break;
    case "OBJECT":
    case "JSON":
      schema.type = "object";
      break;
    case "FILE":
      schema.type = "string";
      schema.format = "binary";
      break;
    default:
      schema.type = "string";
  }

  if (prop.description) {
    schema.description = prop.description;
  }

  if (prop.defaultValue !== undefined) {
    schema.default = prop.defaultValue;
  }

  return schema;
}

/**
 * Convert piece action props to JSON Schema
 */
export function pieceActionToJsonSchema(
  action: PieceAction
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, prop] of Object.entries(action.props)) {
    properties[key] = {
      ...apPropertyTypeToJsonSchema(prop),
      title: prop.displayName,
    };

    if (prop.required) {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
}
