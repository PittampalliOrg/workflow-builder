/**
 * Public entry point for the workflow→code emitter.
 *
 * Usage:
 *   const result = await emitWorkflow(spec, { language: 'typescript', userId });
 *   // result.source          — the emitted file text
 *   // result.supportingFiles — shim + inlined supporting files to persist
 *   // result.warnings        — surfaced to the caller for UI display
 *   // result.compositionGraph — flat summary for catalog storage
 */

import { extractTriggerSchema, getWorkflowName, normalizeDoArray } from './normalize';
import { resolveInlines, type InlineCodeFunctionReader } from './inline-resolver';
import { emitTypeScript } from './emit-ts';
import { emitPython } from './emit-py';
import { summarizeComposition, type EmitWorkflowInput } from './ir';
import type { CodeFunctionCompositionGraph } from '$lib/server/code-functions/model';

// Vendored shim sources — loaded at build time as plain strings so the
// emitter can embed them into each workflow's supporting_files.
import shimTsSource from './shim/runtime.ts.txt?raw';
import shimPySource from './shim/runtime.py.txt?raw';

export type EmitterLanguage = 'typescript' | 'python';

export interface EmitWorkflowOptions {
	language: EmitterLanguage;
	userId?: string | null;
	/** When false, every code/<slug> call stays as a shim dispatch (no inlining). */
	inlineFunctions?: boolean;
	codeFunctions?: InlineCodeFunctionReader;
}

export interface EmitWorkflowResult {
	source: string;
	supportingFiles: Record<string, string>;
	warnings: string[];
	compositionGraph: CodeFunctionCompositionGraph;
	workflowName: string;
	/** File extension for the emitted entry file — consumers use this when
	 *  saving to disk or suggesting a filename. */
	extension: 'ts' | 'py';
	/** suggested filename for a download */
	filename: string;
}

export async function emitWorkflow(
	spec: Record<string, unknown>,
	options: EmitWorkflowOptions,
): Promise<EmitWorkflowResult> {
	const warnings: string[] = [];
	const doArray = Array.isArray(spec.do) ? spec.do : [];
	const baseSteps = normalizeDoArray(doArray, warnings);

	const resolved =
		options.inlineFunctions !== false
			? await resolveInlines({
					steps: baseSteps,
					language: options.language,
					userId: options.userId,
					warnings,
					codeFunctions: options.codeFunctions,
				})
			: { steps: baseSteps, inlinedFunctions: [] };

	const workflowName = getWorkflowName(spec);
	const triggerSchema = extractTriggerSchema(spec);

	const input: EmitWorkflowInput = {
		steps: resolved.steps,
		workflowName,
		triggerSchema,
		inlinedFunctions: resolved.inlinedFunctions,
		warnings,
		originalSpec: spec,
	};

	const composition = summarizeComposition(resolved.steps);

	if (options.language === 'typescript') {
		const result = emitTypeScript(input, shimTsSource);
		return {
			source: result.source,
			supportingFiles: result.supportingFiles,
			warnings: result.warnings,
			compositionGraph: composition,
			workflowName,
			extension: 'ts',
			filename: `${sanitizeFilename(workflowName)}.ts`,
		};
	}

	const result = emitPython(input, shimPySource);
	return {
		source: result.source,
		supportingFiles: result.supportingFiles,
		warnings: result.warnings,
		compositionGraph: composition,
		workflowName,
		extension: 'py',
		filename: `${sanitizeFilename(workflowName)}.py`,
	};
}

function sanitizeFilename(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9-_.]+/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-+|-+$/g, '') || 'workflow'
	);
}
