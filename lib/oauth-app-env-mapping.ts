/**
 * OAuth App Environment Variable Mapping
 *
 * Maps OAUTH_APP_<SUFFIX>_CLIENT_ID env var suffixes to AP piece names.
 * Handles multi-piece providers (one OAuth app covers multiple AP pieces).
 *
 * Convention:
 *   Env: OAUTH_APP_GOOGLE_CLIENT_ID / OAUTH_APP_GOOGLE_CLIENT_SECRET
 *   Key Vault: OAUTH-APP-GOOGLE-CLIENT-ID / OAUTH-APP-GOOGLE-CLIENT-SECRET
 *   Suffix: "GOOGLE"
 */

/**
 * Multi-piece providers: one OAuth app credential covers multiple AP pieces.
 * Key = env var suffix (UPPERCASE), Value = array of AP piece short names.
 */
const MULTI_PIECE_MAPPINGS: Record<string, string[]> = {
  GOOGLE: [
    "google-sheets",
    "google-calendar",
    "google-docs",
    "gmail",
    "google-drive",
  ],
  MICROSOFT: [
    "microsoft-teams",
    "microsoft-outlook",
    "microsoft-excel-365",
    "microsoft-todo",
  ],
};

/**
 * Given an env var suffix (e.g. "GOOGLE", "DISCORD"), return the AP piece
 * short names it covers.
 *
 * - Multi-piece providers use MULTI_PIECE_MAPPINGS
 * - Single-piece providers: suffix is lowercased and underscores become hyphens
 *   e.g. "DISCORD" -> ["discord"], "JIRA_CLOUD" -> ["jira-cloud"]
 */
export function envSuffixToPieceNames(suffix: string): string[] {
  if (MULTI_PIECE_MAPPINGS[suffix]) {
    return MULTI_PIECE_MAPPINGS[suffix];
  }
  return [suffix.toLowerCase().replace(/_/g, "-")];
}

/**
 * Convert a short piece name to the full AP package name.
 * e.g. "google-sheets" -> "@activepieces/piece-google-sheets"
 */
export function pieceNameToFullName(name: string): string {
  return `@activepieces/piece-${name}`;
}
