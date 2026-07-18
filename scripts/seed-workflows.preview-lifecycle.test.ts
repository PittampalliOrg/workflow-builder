import { describe, expect, it } from "vitest";
import { extractMeta } from "../services/script-evaluator/src/meta";
import {
	hostPreviewLifecycleDefinition,
	previewUiDevelopmentGanDefinition,
} from "./lib/preview-lifecycle-definitions";

function inputProperties(meta: Record<string, unknown>): Record<string, unknown> {
	return (
		(meta.input as { properties?: Record<string, unknown> } | undefined)
			?.properties ?? {}
	);
}

describe("seed-workflows preview lifecycle schema", () => {
	it("persists the authoritative fixture metadata without a second schema copy", () => {
		for (const definition of [
			hostPreviewLifecycleDefinition(),
			previewUiDevelopmentGanDefinition(),
		]) {
			const extracted = extractMeta(definition.script);
			expect(extracted.ok, extracted.error).toBe(true);
			expect(definition.meta).toEqual(extracted.meta);
			expect(definition.description).toBe(extracted.meta?.description);
		}
	});

	it("seeds every retained and impact-review child input", () => {
		const child = inputProperties(previewUiDevelopmentGanDefinition().meta);
		expect(child).toHaveProperty("ttlHours");
		expect(child).toHaveProperty("retainAfterCompletion");
		expect(child).toHaveProperty("interactiveHandoff");
		expect(child).toHaveProperty("impactReview");
		expect(child).toHaveProperty("diffScope");
	});

	it("keeps the host launcher schema aligned with its fixture", () => {
		const host = hostPreviewLifecycleDefinition().meta;
		const properties = inputProperties(host);
		expect(properties).toHaveProperty("retainAfterCompletion");
		expect(properties).toHaveProperty("retainOnFailure");
		expect(properties).toHaveProperty("interactiveHandoff");
		expect(properties.services).toMatchObject({ maxItems: 16 });
	});
});
