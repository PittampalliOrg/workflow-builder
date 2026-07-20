import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
	new URL("./run-instance-drawer.svelte", import.meta.url),
	"utf8",
);

describe("run instance trace fallback", () => {
	it("renders a returned trace bundle before the no-trace-id empty state", () => {
		const traceTabStart = source.indexOf('<!-- Trace detail -->');
		const traceTabEnd = source.indexOf('<!-- Harness -->', traceTabStart);
		const traceTab = source.slice(traceTabStart, traceTabEnd);

		const returnedBundleBranch = traceTab.indexOf("{:else if spans && runId && instanceId}");
		const noTraceIdsBranch = traceTab.indexOf(
			"{:else if (detail.runInstance.traceIds?.length ?? 0) === 0}",
		);

		expect(returnedBundleBranch).toBeGreaterThan(-1);
		expect(noTraceIdsBranch).toBeGreaterThan(returnedBundleBranch);
		expect(traceTab).toContain("traceSpans={spans.traceSpans ?? []}");
	});
});
