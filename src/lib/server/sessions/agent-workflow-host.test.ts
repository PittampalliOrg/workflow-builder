import { describe, expect, it } from "vitest";
import { extractTraceContext } from "./agent-workflow-host";

describe("agent workflow host trace context", () => {
	it("extracts W3C trace headers including baggage", () => {
		const headers = new Headers({
			traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
			tracestate: "vendor=value",
			baggage: "workflow.execution.id=exec_1,session.id=session_1",
		});

		expect(extractTraceContext({ headers })).toEqual({
			traceparent:
				"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
			tracestate: "vendor=value",
			baggage: "workflow.execution.id=exec_1,session.id=session_1",
		});
	});
});
