import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "+page.svelte"),
	"utf8",
);

describe("workspace dev detail polling", () => {
	it("keeps one remote query handle whose refreshed values drive services and lifecycle", () => {
		expect(pageSource).toContain(
			"const initialExecutionId = untrack(() => data.environment.executionId);",
		);
		expect(pageSource).toContain(
			"const envQuery = getDevEnvironment(initialExecutionId);",
		);
		expect(pageSource).not.toContain(
			"$derived(getDevEnvironment(data.environment.executionId))",
		);
		expect(pageSource).toContain(
			"envQuery.current?.environment ?? data.environment",
		);
		expect(pageSource).toContain(
			"envQuery.current?.services ?? data.services ?? [data.environment]",
		);
		expect(pageSource).toContain(
			"setInterval(() => void envQuery.refresh(), 5000)",
		);
		expect(pageSource).toContain("runStatus: environment.runStatus");
		expect(pageSource).toContain("<StatusPill status={lifecycle.effectiveStatus}");
		expect(pageSource).toContain("{services.length} service");
		expect(pageSource).toContain("{#each services as svc (svc.service)}");
	});
});
