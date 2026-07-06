/**
 * Emit the preview-family GAN fixtures from the typed generator.
 *
 * Usage:  tsx scripts/generate-gan-fixtures.ts [--check]
 *   (default) writes the fixture(s) to scripts/fixtures/generator-critic/
 *   --check   fails (exit 1) if a checked-in fixture is out of date — the drift
 *             guard the golden test also enforces.
 *
 * Only preview-gan-ui-feature is generated in this pass. To add another family
 * (e.g. preview-gan-redesign) later: define its GanFixtureConfig and append an
 * entry to TARGETS.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PREVIEW_GAN_UI_FEATURE_CONFIG } from "./fixtures/generator-critic/gen/gan-config";
import { renderGanFixture } from "./fixtures/generator-critic/gen/gan-fixture-generator";
import type { GanFixtureConfig } from "./fixtures/generator-critic/gen/gan-config";

interface Target {
	config: GanFixtureConfig;
	outPath: string;
}

const TARGETS: Target[] = [
	{
		config: PREVIEW_GAN_UI_FEATURE_CONFIG,
		outPath: resolve(process.cwd(), "scripts/fixtures/generator-critic/preview-gan-ui-feature.json"),
	},
];

function main() {
	const check = process.argv.includes("--check");
	let drift = false;
	for (const { config, outPath } of TARGETS) {
		const rendered = renderGanFixture(config);
		if (check) {
			let current = "";
			try {
				current = readFileSync(outPath, "utf8");
			} catch {
				current = "";
			}
			if (current !== rendered) {
				drift = true;
				console.error(`[generate-gan-fixtures] OUT OF DATE: ${outPath}`);
			} else {
				console.log(`[generate-gan-fixtures] up to date: ${outPath}`);
			}
		} else {
			writeFileSync(outPath, rendered);
			console.log(`[generate-gan-fixtures] wrote ${outPath}`);
		}
	}
	if (check && drift) {
		console.error("[generate-gan-fixtures] run `tsx scripts/generate-gan-fixtures.ts` to regenerate.");
		process.exit(1);
	}
}

main();
