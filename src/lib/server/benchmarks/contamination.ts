export const CONTAMINATION_RISK_QUERY_PARAM = "includeContaminationRiskMetadata";

const CONTAMINATION_RISK_TEST_METADATA_KEYS = new Set([
	"test_patch",
	"testPatch",
	"FAIL_TO_PASS",
	"fail_to_pass",
	"PASS_TO_PASS",
	"pass_to_pass",
	"goldPatch",
	"gold_patch",
	"patch",
]);

const PUBLIC_TEST_METADATA_KEYS = [
	"version",
	"environmentSetupCommit",
	"environment_setup_commit",
	"environmentKey",
	"environment_key",
] as const;

export type ContaminationRiskMetadataState = {
	included: boolean;
	redacted: boolean;
	mode: "agent_visible" | "operator_audit";
};

export function wantsContaminationRiskMetadata(url: URL): boolean {
	const explicit =
		url.searchParams.get(CONTAMINATION_RISK_QUERY_PARAM) ??
		url.searchParams.get("includeContaminationRisk") ??
		url.searchParams.get("audit");
	return explicit === "1" || explicit === "true" || explicit === "contamination-risk";
}

export function containsContaminationRiskMetadata(
	metadata: Record<string, unknown> | null | undefined,
): boolean {
	if (!metadata) return false;
	return Object.keys(metadata).some((key) =>
		CONTAMINATION_RISK_TEST_METADATA_KEYS.has(key),
	);
}

export function publicSwebenchTestMetadata(
	metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
	if (!metadata) return {};
	const out: Record<string, unknown> = {};
	for (const key of PUBLIC_TEST_METADATA_KEYS) {
		const value = metadata[key];
		if (value !== undefined && value !== null && value !== "") out[key] = value;
	}
	return out;
}

export function mergeServerSwebenchTestMetadata(params: {
	serverMetadata?: Record<string, unknown> | null;
	requestMetadata?: Record<string, unknown> | null;
}): Record<string, unknown> {
	return {
		...(params.serverMetadata ?? {}),
		...(params.requestMetadata ?? {}),
	};
}

type ContaminationAuditProjectRole = "ADMIN" | "EDITOR" | "OPERATOR" | "VIEWER";

export function canProjectRoleAuditContaminationMetadata(
	role: ContaminationAuditProjectRole | null,
): boolean {
	return role === "ADMIN" || role === "OPERATOR";
}

export function contaminationRiskMetadataState(
	included: boolean,
): ContaminationRiskMetadataState {
	return {
		included,
		redacted: !included,
		mode: included ? "operator_audit" : "agent_visible",
	};
}
