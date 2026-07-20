import test from "node:test";
import assert from "node:assert/strict";
import {
	parseTargetAuth,
	WORKFLOW_BUILDER_ACCESS_TOKEN_COOKIE,
} from "./target-auth-policy.mjs";

test("normalizes rolling-deployment bearer credentials to a host-scoped cookie", () => {
	assert.deepEqual(
		parseTargetAuth({
			"x-wfb-target-auth": "Bearer execution-owner-token",
			"x-wfb-target-auth-host":
				"Workflow-Builder.Workflow-Builder.svc.cluster.local",
		}),
		{
			host: "workflow-builder.workflow-builder.svc.cluster.local",
			cookieName: WORKFLOW_BUILDER_ACCESS_TOKEN_COOKIE,
			cookieValue: "execution-owner-token",
		},
	);
});

test("preserves explicit cookie credentials and rejects incomplete input", () => {
	assert.deepEqual(
		parseTargetAuth({
			"x-wfb-target-auth": "session=value",
			"x-wfb-target-auth-host": "example.test:3000",
		}),
		{
			host: "example.test:3000",
			cookieName: "session",
			cookieValue: "value",
		},
	);
	assert.equal(
		parseTargetAuth({ "x-wfb-target-auth": "Bearer token" }),
		null,
	);
});
