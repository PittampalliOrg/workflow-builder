/**
 * Validates a SW 1.0 spec using the official @serverlessworkflow/sdk.
 * Returns validation result with errors if invalid.
 */

import * as swSdk from '@serverlessworkflow/sdk';

const sdk = ((swSdk as { default?: unknown }).default ?? swSdk) as typeof import('@serverlessworkflow/sdk');
const { validate } = sdk;

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

/**
 * Validate a SW 1.0 spec object.
 */
export function validateSpec(spec: unknown): ValidationResult {
	try {
		validate('Workflow', spec);
		return { valid: true, errors: [] };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Parse AJV-style validation errors if present
		const errors = parseValidationErrors(message);
		return { valid: false, errors: errors.length > 0 ? errors : [message] };
	}
}

/**
 * Parse validation error messages into individual error strings.
 */
function parseValidationErrors(message: string): string[] {
	// AJV errors often come as multi-line strings
	const lines = message.split('\n').filter((l) => l.trim().length > 0);
	if (lines.length > 1) return lines;
	return [message];
}
