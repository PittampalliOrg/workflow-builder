import fs from "node:fs";
import path from "node:path";
import { extractMeta } from "../../services/script-evaluator/src/meta";

export type PreviewLifecycleDefinition = {
	script: string;
	description: string;
	meta: Record<string, unknown>;
};

function loadDefinition(
	fixtureName: string,
	expectedName: string,
): PreviewLifecycleDefinition {
	const script = fs.readFileSync(
		path.resolve(
			process.cwd(),
			"scripts/fixtures/dynamic-scripts",
			fixtureName,
		),
		"utf8",
	);
	const extracted = extractMeta(script);
	if (!extracted.ok || !extracted.meta) {
		throw new Error(
			`Failed to extract metadata from ${fixtureName}: ${extracted.error ?? "invalid meta export"}`,
		);
	}
	if (extracted.meta.name !== expectedName) {
		throw new Error(
			`${fixtureName} must export meta.name=${JSON.stringify(expectedName)}`,
		);
	}
	if (
		typeof extracted.meta.description !== "string" ||
		extracted.meta.description.length === 0
	) {
		throw new Error(`${fixtureName} must export a non-empty meta.description`);
	}
	return {
		script,
		description: extracted.meta.description,
		meta: extracted.meta,
	};
}

export function hostPreviewLifecycleDefinition(): PreviewLifecycleDefinition {
	return loadDefinition(
		"preview-development-lifecycle.js",
		"preview-development-lifecycle",
	);
}

export function previewUiDevelopmentGanDefinition(): PreviewLifecycleDefinition {
	return loadDefinition(
		"preview-ui-development-gan.js",
		"preview-ui-development-gan",
	);
}
