/**
 * Piece Auth Types
 *
 * TypeScript types for Activepieces piece authentication schemas.
 * These describe the `auth` field stored in `piece_metadata.auth` (JSONB).
 *
 * Reference: activepieces/packages/pieces/community/framework/src/lib/property/authentication/
 */

/**
 * Property types used in piece auth configuration.
 * Subset of the full PropertyType enum relevant to auth fields.
 */
export enum PiecePropertyType {
  SHORT_TEXT = "SHORT_TEXT",
  LONG_TEXT = "LONG_TEXT",
  NUMBER = "NUMBER",
  CHECKBOX = "CHECKBOX",
  SECRET_TEXT = "SECRET_TEXT",
  STATIC_DROPDOWN = "STATIC_DROPDOWN",
  STATIC_MULTI_SELECT_DROPDOWN = "STATIC_MULTI_SELECT_DROPDOWN",
  MARKDOWN = "MARKDOWN",
}

/**
 * Auth property types (maps to PropertyType in upstream)
 */
export enum PieceAuthType {
  SECRET_TEXT = "SECRET_TEXT",
  BASIC_AUTH = "BASIC_AUTH",
  CUSTOM_AUTH = "CUSTOM_AUTH",
  OAUTH2 = "OAUTH2",
  /** No auth required */
  NONE = "NONE",
}

/**
 * OAuth2 authorization method
 */
export enum OAuth2AuthorizationMethod {
  HEADER = "HEADER",
  BODY = "BODY",
}

/**
 * OAuth2 grant type
 */
export enum OAuth2GrantType {
  AUTHORIZATION_CODE = "authorization_code",
  CLIENT_CREDENTIALS = "client_credentials",
}

/**
 * Base property definition in auth config
 */
export type PieceAuthPropertyBase = {
  displayName: string;
  description?: string;
  required?: boolean;
  defaultValue?: unknown;
};

/**
 * Short text property (for text inputs in auth forms)
 */
export type ShortTextProperty = PieceAuthPropertyBase & {
  type: PiecePropertyType.SHORT_TEXT;
};

/**
 * Long text property (for textarea inputs)
 */
export type LongTextProperty = PieceAuthPropertyBase & {
  type: PiecePropertyType.LONG_TEXT;
};

/**
 * Number property
 */
export type NumberProperty = PieceAuthPropertyBase & {
  type: PiecePropertyType.NUMBER;
};

/**
 * Checkbox property
 */
export type CheckboxProperty = PieceAuthPropertyBase & {
  type: PiecePropertyType.CHECKBOX;
};

/**
 * Secret text property (for password inputs)
 */
export type SecretTextProperty = PieceAuthPropertyBase & {
  type: PiecePropertyType.SECRET_TEXT;
};

/**
 * Static dropdown property
 */
export type StaticDropdownProperty = PieceAuthPropertyBase & {
  type: PiecePropertyType.STATIC_DROPDOWN;
  options: {
    disabled?: boolean;
    placeholder?: string;
    options: Array<{
      label: string;
      value: string;
    }>;
  };
};

/**
 * Markdown property (display-only, not an input)
 */
export type MarkdownProperty = {
  type: PiecePropertyType.MARKDOWN;
  value: string;
  description?: string;
};

/**
 * Any property that can appear in custom auth or OAuth2 extra props
 */
export type PieceAuthProperty =
  | ShortTextProperty
  | LongTextProperty
  | NumberProperty
  | CheckboxProperty
  | SecretTextProperty
  | StaticDropdownProperty
  | MarkdownProperty;

/**
 * SECRET_TEXT auth config
 * Single secret input (e.g., API key)
 */
export type SecretTextAuthConfig = {
  type: PieceAuthType.SECRET_TEXT;
  displayName: string;
  description?: string;
  required?: boolean;
};

/**
 * BASIC_AUTH auth config
 * Username + password
 */
export type BasicAuthConfig = {
  type: PieceAuthType.BASIC_AUTH;
  displayName: string;
  description?: string;
  username: {
    displayName: string;
    description?: string;
  };
  password: {
    displayName: string;
    description?: string;
  };
};

/**
 * CUSTOM_AUTH auth config
 * Arbitrary set of input properties
 */
export type CustomAuthConfig = {
  type: PieceAuthType.CUSTOM_AUTH;
  displayName: string;
  description?: string;
  props: Record<string, PieceAuthProperty>;
};

/**
 * OAUTH2 auth config
 * Full OAuth2 configuration
 */
export type OAuth2AuthConfig = {
  type: PieceAuthType.OAUTH2;
  displayName: string;
  description?: string;
  authUrl: string;
  tokenUrl: string;
  scope: string[];
  prompt?: "none" | "consent" | "login" | "omit";
  pkce?: boolean;
  pkceMethod?: "plain" | "S256";
  authorizationMethod?: OAuth2AuthorizationMethod;
  grantType?:
    | OAuth2GrantType
    | "both_client_credentials_and_authorization_code";
  extra?: Record<string, string>;
  props?: Record<string, PieceAuthProperty>;
};

/**
 * Union of all auth configurations that can appear in piece_metadata.auth
 */
export type PieceAuthConfig =
  | SecretTextAuthConfig
  | BasicAuthConfig
  | CustomAuthConfig
  | OAuth2AuthConfig
  | null
  | undefined;

/**
 * Parse a single raw auth object into a typed PieceAuthConfig.
 */
function parsePieceAuthSingle(raw: unknown): PieceAuthConfig {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const type = obj.type as string | undefined;

  if (!type) {
    return null;
  }

  switch (type) {
    case PieceAuthType.SECRET_TEXT:
    case "SECRET_TEXT":
      return {
        type: PieceAuthType.SECRET_TEXT,
        displayName: (obj.displayName as string) ?? "Connection",
        description: obj.description as string | undefined,
        required: obj.required as boolean | undefined,
      };

    case PieceAuthType.BASIC_AUTH:
    case "BASIC_AUTH":
      return {
        type: PieceAuthType.BASIC_AUTH,
        displayName: (obj.displayName as string) ?? "Connection",
        description: obj.description as string | undefined,
        username: (obj.username as BasicAuthConfig["username"]) ?? {
          displayName: "Username",
        },
        password: (obj.password as BasicAuthConfig["password"]) ?? {
          displayName: "Password",
        },
      };

    case PieceAuthType.CUSTOM_AUTH:
    case "CUSTOM_AUTH":
      return {
        type: PieceAuthType.CUSTOM_AUTH,
        displayName: (obj.displayName as string) ?? "Connection",
        description: obj.description as string | undefined,
        props: (obj.props as Record<string, PieceAuthProperty>) ?? {},
      };

    case PieceAuthType.OAUTH2:
    case "OAUTH2":
      return {
        type: PieceAuthType.OAUTH2,
        displayName: (obj.displayName as string) ?? "Connection",
        description: obj.description as string | undefined,
        authUrl: (obj.authUrl as string) ?? "",
        tokenUrl: (obj.tokenUrl as string) ?? "",
        scope: (obj.scope as string[]) ?? [],
        prompt: obj.prompt as OAuth2AuthConfig["prompt"],
        pkce: obj.pkce as boolean | undefined,
        pkceMethod: obj.pkceMethod as OAuth2AuthConfig["pkceMethod"],
        authorizationMethod: obj.authorizationMethod as
          | OAuth2AuthorizationMethod
          | undefined,
        grantType: obj.grantType as OAuth2AuthConfig["grantType"],
        extra: obj.extra as Record<string, string> | undefined,
        props: obj.props as Record<string, PieceAuthProperty> | undefined,
      };

    default:
      return null;
  }
}

/**
 * Parse the raw auth JSONB from piece_metadata into a list of typed auth configs.
 *
 * Activepieces supports:
 * - null/undefined (no auth)
 * - a single auth object
 * - an array of auth objects (multiple auth methods per piece)
 */
export function parsePieceAuthAll(
  raw: unknown
): Exclude<PieceAuthConfig, null | undefined>[] {
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw
      .map(parsePieceAuthSingle)
      .filter((c): c is Exclude<PieceAuthConfig, null | undefined> =>
        Boolean(c)
      );
  }
  const single = parsePieceAuthSingle(raw);
  return single ? [single as Exclude<PieceAuthConfig, null | undefined>] : [];
}

/**
 * Parse the raw auth JSONB from piece_metadata into a single typed auth config.
 *
 * Kept for backward compatibility: when multiple configs exist, the first is returned.
 */
export function parsePieceAuth(raw: unknown): PieceAuthConfig {
  return parsePieceAuthAll(raw)[0] ?? null;
}
