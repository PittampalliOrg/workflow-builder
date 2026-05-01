import { describe, expect, it } from "vitest";
import {
	canProjectRoleAuditContaminationMetadata,
	containsContaminationRiskMetadata,
	contaminationRiskMetadataState,
	publicSwebenchTestMetadata,
	wantsContaminationRiskMetadata,
} from "./contamination";

describe("SWE-bench contamination-risk metadata redaction", () => {
	it("redacts hidden evaluator metadata from public test metadata", () => {
		expect(
			publicSwebenchTestMetadata({
				version: "1.7",
				environment_setup_commit: "env123",
				test_patch: "diff --git a/tests/test_fix.py b/tests/test_fix.py\n",
				FAIL_TO_PASS: ["tests/test_fix.py::test_regression"],
				PASS_TO_PASS: ["tests/test_existing.py::test_existing"],
				goldPatch: "diff --git a/src/fix.py b/src/fix.py\n",
			}),
		).toEqual({
			version: "1.7",
			environment_setup_commit: "env123",
		});
	});

	it("detects explicit audit mode and project roles allowed to use it", () => {
		expect(
			wantsContaminationRiskMetadata(
				new URL("http://localhost/api?includeContaminationRiskMetadata=1"),
			),
		).toBe(true);
		expect(
			wantsContaminationRiskMetadata(new URL("http://localhost/api?audit=contamination-risk")),
		).toBe(true);
		expect(wantsContaminationRiskMetadata(new URL("http://localhost/api"))).toBe(false);
		expect(canProjectRoleAuditContaminationMetadata("ADMIN")).toBe(true);
		expect(canProjectRoleAuditContaminationMetadata("OPERATOR")).toBe(true);
		expect(canProjectRoleAuditContaminationMetadata("EDITOR")).toBe(false);
		expect(canProjectRoleAuditContaminationMetadata("VIEWER")).toBe(false);
	});

	it("marks default responses as redacted agent-visible mode", () => {
		expect(
			containsContaminationRiskMetadata({
				test_patch: "diff",
			}),
		).toBe(true);
		expect(contaminationRiskMetadataState(false)).toEqual({
			included: false,
			redacted: true,
			mode: "agent_visible",
		});
		expect(contaminationRiskMetadataState(true)).toEqual({
			included: true,
			redacted: false,
			mode: "operator_audit",
		});
	});
});
