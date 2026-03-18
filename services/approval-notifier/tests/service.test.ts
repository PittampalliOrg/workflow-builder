import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	approvalNotificationStateKey,
	buildApprovalNotificationPayload,
	deliverApprovalRequestedNotification,
	parseReceivers,
} from "../src/service.js";

describe("approval-notifier", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("parses enabled receivers from json", () => {
		const receivers = parseReceivers(
			JSON.stringify([
				{ name: "ryzen", url: "http://ryzen.local/notify" },
				{ name: "bad", enabled: true },
				{
					name: "thinkpad",
					url: "http://thinkpad.local/notify",
					enabled: false,
				},
			]),
		);

		expect(receivers).toEqual([
			{
				name: "ryzen",
				url: "http://ryzen.local/notify",
				method: "POST",
				timeoutSeconds: 5,
				headers: {},
				enabled: true,
			},
			{
				name: "thinkpad",
				url: "http://thinkpad.local/notify",
				method: "POST",
				timeoutSeconds: 5,
				headers: {},
				enabled: false,
			},
		]);
	});

	it("builds a run url for the approval notification payload", () => {
		const payload = buildApprovalNotificationPayload(
			{
				type: "workflow.approval.requested",
				traceId: "trace-123",
				data: {
					workflowId: "agentsysdemo001",
					executionId: "exec-1",
					nodeId: "approve-node",
					nodeName: "Approve Plan",
					eventName: "plan_approval",
				},
			},
			"https://workflow-builder-ryzen.tail286401.ts.net",
		);

		expect(payload.runUrl).toBe(
			"https://workflow-builder-ryzen.tail286401.ts.net/workflows/agentsysdemo001/runs/exec-1",
		);
		expect(
			approvalNotificationStateKey({
				data: {
					executionId: "exec-1",
					nodeId: "approve-node",
					eventName: "plan_approval",
				},
			}),
		).toBe("workflow-approval:exec-1:approve-node:plan_approval");
	});

	it("delivers only once per receiver for the same approval event", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				text: async () => "",
			})
			.mockResolvedValueOnce({
				ok: true,
				text: async () => "",
			})
			.mockResolvedValueOnce({
				ok: true,
			})
			.mockResolvedValueOnce({
				ok: true,
				text: async () =>
					JSON.stringify({
						dedupeKey: "workflow-approval:exec-1:approve-node:plan_approval",
						deliveredReceivers: ["ryzen"],
						lastAttemptAt: "2026-03-18T00:00:00Z",
					}),
			})
			.mockResolvedValueOnce({
				ok: true,
			});
		vi.stubGlobal("fetch", fetchMock);

		const event = {
			type: "workflow.approval.requested",
			data: {
				workflowId: "agentsysdemo001",
				executionId: "exec-1",
				nodeId: "approve-node",
				eventName: "plan_approval",
			},
		};
		const receivers = [{ name: "ryzen", url: "http://ryzen.local/notify" }];

		const first = await deliverApprovalRequestedNotification(event, {
			receivers,
			workflowBuilderBaseUrl:
				"https://workflow-builder-ryzen.tail286401.ts.net",
			stateStoreName: "workflowstatestore",
			daprHttpBaseUrl: "http://127.0.0.1:3500",
		});
		const second = await deliverApprovalRequestedNotification(event, {
			receivers,
			workflowBuilderBaseUrl:
				"https://workflow-builder-ryzen.tail286401.ts.net",
			stateStoreName: "workflowstatestore",
			daprHttpBaseUrl: "http://127.0.0.1:3500",
		});

		expect(first.delivered).toEqual(["ryzen"]);
		expect(second.delivered).toEqual([]);
		expect(second.skipped).toEqual(["ryzen"]);
		expect(fetchMock).toHaveBeenCalledTimes(5);
	});
});
