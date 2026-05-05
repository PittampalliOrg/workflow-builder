import { describe, expect, it } from "vitest";
import { publicMlflowTracesUrl } from "./mlflow";

describe("publicMlflowTracesUrl", () => {
	it("routes benchmark trace links through the trace-experiment redirect", () => {
		expect(publicMlflowTracesUrl("1", "abc123")).toBe(
			"/api/observability/mlflow/traces/abc123",
		);
	});

	it("omits links when no trace id was recorded", () => {
		expect(publicMlflowTracesUrl("1", null)).toBeNull();
	});
});
