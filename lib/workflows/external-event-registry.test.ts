import { describe, expect, it } from "vitest";
import { resolveSupportedWorkflowTriggerFromEnvelope } from "./external-event-registry";

describe("resolveSupportedWorkflowTriggerFromEnvelope", () => {
	it("accepts labeled GitHub issue events", () => {
		const resolved = resolveSupportedWorkflowTriggerFromEnvelope({
			source: "github",
			eventType: "issues",
			payload: {
				action: "labeled",
				issue: {
					number: 11,
					title: "Fix issue",
					body: "Please fix it",
					labels: [{ name: "dapr-swe" }],
				},
				repository: {
					name: "open-swe",
					owner: { login: "PittampalliOrg" },
				},
				sender: { login: "vinod" },
			},
		});

		expect(resolved).toMatchObject({
			status: "accepted",
			workflowId: "vajlzrprpie7fvco6ibhi",
			input: {
				owner: "PittampalliOrg",
				repo: "open-swe",
				issue_number: 11,
				title: "Fix issue",
				body: "Please fix it",
				sender: "vinod",
			},
		});
	});

	it("accepts Gitea issue_label events", () => {
		const resolved = resolveSupportedWorkflowTriggerFromEnvelope({
			source: "gitea",
			eventType: "issue_label",
			payload: {
				action: "label_updated",
				label: { name: "dapr-swe" },
				issue: {
					number: 13,
					title: "Fix from gitea",
					body: "Handle Gitea test repo",
				},
				repository: {
					name: "open-swe",
					owner: { username: "giteaadmin" },
				},
				sender: { username: "giteaadmin" },
			},
		});

		expect(resolved).toMatchObject({
			status: "accepted",
			workflowId: "vajlzrprpie7fvco6ibhi",
			input: {
				owner: "giteaadmin",
				repo: "open-swe",
				issue_number: 13,
				title: "Fix from gitea",
				body: "Handle Gitea test repo",
				sender: "giteaadmin",
			},
		});
	});

	it("ignores events without the trigger label", () => {
		const resolved = resolveSupportedWorkflowTriggerFromEnvelope({
			source: "gitea",
			eventType: "issue_label",
			payload: {
				label: { name: "bug" },
				issue: { number: 1, title: "Fix issue" },
				repository: {
					name: "open-swe",
					owner: { username: "giteaadmin" },
				},
			},
		});

		expect(resolved).toEqual({
			status: "ignored",
			reason: "Issue does not have the trigger label",
		});
	});
});
