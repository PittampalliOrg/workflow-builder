import { describe, expect, it } from 'vitest';
import { parseScriptStructure } from '$lib/utils/script-graph-adapter';
import { ANALYSIS_SCRIPT } from './trace-analysis-workflow';

describe('trace-deep-analysis seeded script', () => {
	it('parses structurally: two phases, parallel reviewers + schema synthesis', () => {
		const m = parseScriptStructure(ANALYSIS_SCRIPT);
		expect(m.phases).toEqual(['Review', 'Synthesize']);
		const kinds = m.calls.map((c) => c.kind);
		expect(kinds).toContain('parallel');
		expect(kinds.filter((k) => k === 'agent').length).toBeGreaterThanOrEqual(2);
	});

	it('contains no escaping artifacts from the TS template embedding', () => {
		// A broken embed would leave literal \` or \${ sequences in the script.
		expect(ANALYSIS_SCRIPT).not.toContain('\\`\\`');
		expect(ANALYSIS_SCRIPT).toContain('export const meta');
		expect(ANALYSIS_SCRIPT).toContain('phase("Review")');
		expect(ANALYSIS_SCRIPT).toContain('schema: {');
		// The synthesis schema must be strict-compatible (all keys required).
		expect(ANALYSIS_SCRIPT).toContain('"summary", "healthScore", "findings", "improvements"');
	});
});
