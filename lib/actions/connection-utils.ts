import type { IntegrationType } from "@/lib/actions/types";

/**
 * Map of action types that require a specific integration connection.
 * When a user configures one of these actions, the UI will prompt them
 * to select or create a connection for the required integration type.
 */
const ACTION_REQUIRED_INTEGRATIONS: Record<string, IntegrationType> = {
	"mastra/clone": "github",
};

/**
 * Check if an action type requires a specific integration connection.
 * Returns the integration type (e.g. "github") if a connection is needed,
 * or undefined if the action doesn't require one.
 */
export function getRequiredConnectionForAction(
	actionType: string | null | undefined,
): IntegrationType | undefined {
	if (!actionType) {
		return undefined;
	}
	return ACTION_REQUIRED_INTEGRATIONS[actionType];
}

/**
 * Check if an integration type requires a connection to be configured.
 * Returns true for all non-null integration types.
 */
export function requiresConnectionForIntegration(
	integrationType: string | null | undefined,
): boolean {
	if (!integrationType) {
		return false;
	}
	if (
		integrationType === "system" ||
		integrationType === "durable" ||
		integrationType === "mcp" ||
		integrationType === "workspace" ||
		integrationType === "mastra"
	) {
		return false;
	}
	return true;
}
