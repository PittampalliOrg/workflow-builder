import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "data.remote.ts"),
	"utf8",
);

describe("dev environment detail data remote", () => {
	it("delegates to the application services (never the DB/legacy sidecar client)", () => {
		expect(source).toContain("workflowData.getDevEnvironmentOrPending");
		expect(source).toContain("workflowData.listDevEnvironmentGroups");
		expect(source).toContain("devPreviewSidecar.status");
		expect(source).toContain("devPreviewSidecar.run");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/workflows/dev-preview-sidecar");
	});

	it("guards on the session and maps a missing env to 404", () => {
		expect(source).toContain("getRequestEvent");
		expect(source).toContain("Authentication required");
		expect(source).toContain("Dev environment not found");
		expect(source).toContain("Dev environment service not found");
	});
});
