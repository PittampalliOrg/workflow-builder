import { describe, expect, it } from "vitest";
import { planProjectSystemWorkflowInstallations } from "./project-system-workflows";

describe("planProjectSystemWorkflowInstallations", () => {
	it("keeps the canonical project unchanged and plans stable copies for other projects", () => {
		const input = {
			baseWorkflowId: "preview-development-lifecycle",
			canonicalProjectId: "github-project",
			owners: [
				{ projectId: "github-project", userId: "github-user" },
				{ projectId: "dev-default-project", userId: "dev-admin-user" },
			],
		};

		const first = planProjectSystemWorkflowInstallations(input);
		const second = planProjectSystemWorkflowInstallations(input);

		expect(first).toEqual(second);
		expect(first).toEqual([
			{
				projectId: "dev-default-project",
				userId: "dev-admin-user",
				workflowId: expect.stringMatching(
					/^preview-development-lifecycle-[0-9a-f]{20}$/,
				),
			},
		]);
	});

	it("deduplicates projects and picks a deterministic owner", () => {
		expect(
			planProjectSystemWorkflowInstallations({
				baseWorkflowId: "preview-development-lifecycle",
				canonicalProjectId: "canonical",
				owners: [
					{ projectId: "shared", userId: "user-z" },
					{ projectId: "shared", userId: "user-a" },
					{ projectId: " ", userId: "ignored" },
				],
			}),
		).toMatchObject([{ projectId: "shared", userId: "user-a" }]);
	});

	it("does not duplicate the canonical workflow when the seed already targets the admin project", () => {
		expect(
			planProjectSystemWorkflowInstallations({
				baseWorkflowId: "preview-development-lifecycle",
				canonicalProjectId: "dev-default-project",
				owners: [
					{ projectId: "dev-default-project", userId: "dev-admin-user" },
				],
			}),
		).toEqual([]);
	});
});
