import { describe, expect, it, vi } from "vitest";

import {
	provisionSessionSandboxWithRetry,
	sandboxProvisionFailureMessage,
} from "./provision";
import type {
	SandboxProvisionInput,
	SandboxProvisionResult,
} from "./provision";

const input: SandboxProvisionInput = {
	executionId: "session-1",
	name: "Session 1",
	sandboxTemplate: "base",
	keepAfterRun: true,
};

const result: SandboxProvisionResult = {
	sandboxName: "ws-ready",
	workspaceRef: "workspace/ws-ready",
	rootPath: "/sandbox",
};

describe("provisionSessionSandboxWithRetry", () => {
	it("retries a transient gRPC/protobuf failure before returning the sandbox", async () => {
		const provision = vi
			.fn()
			.mockRejectedValueOnce(
				new Error(
					'status: Internal, message: "failed to decode Protobuf message: Sandbox.id: invalid string value"',
				),
			)
			.mockResolvedValueOnce(result);

		await expect(
			provisionSessionSandboxWithRetry(input, {
				attempts: 2,
				retryDelayMs: 0,
				provision,
			}),
		).resolves.toEqual(result);
		expect(provision).toHaveBeenCalledTimes(2);
		expect(provision).toHaveBeenNthCalledWith(1, input);
		expect(provision).toHaveBeenNthCalledWith(2, input);
	});

	it("does not retry non-transient validation failures", async () => {
		const err = new Error("sandboxTemplate is required");
		const provision = vi.fn().mockRejectedValue(err);

		await expect(
			provisionSessionSandboxWithRetry(input, {
				attempts: 3,
				retryDelayMs: 0,
				provision,
			}),
		).rejects.toThrow(err);
		expect(provision).toHaveBeenCalledTimes(1);
	});
});

describe("sandboxProvisionFailureMessage", () => {
	it("formats a persisted session error message", () => {
		expect(sandboxProvisionFailureMessage(new Error("other side closed"))).toBe(
			"OpenShell sandbox provisioning failed: other side closed",
		);
	});
});
