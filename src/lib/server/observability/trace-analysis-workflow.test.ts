import { describe, expect, it } from 'vitest';
import { parseScriptStructure } from '$lib/utils/script-graph-adapter';
import { ANALYSIS_SCRIPT } from './trace-analysis-workflow';

describe('trace-deep-analysis seeded script (v2 post-mortem harness)', () => {
	it('parses structurally: four phases, parallel per-session analysts + verifiers + schema synthesis', () => {
		const m = parseScriptStructure(ANALYSIS_SCRIPT);
		expect(m.phases).toEqual(['Collect', 'Analyze', 'Verify', 'Synthesize']);
		const kinds = m.calls.map((c) => c.kind);
		expect(kinds).toContain('parallel');
		expect(kinds.filter((k) => k === 'agent').length).toBeGreaterThanOrEqual(2);
	});

	it('contains no escaping artifacts from the TS template embedding', () => {
		// A broken embed would leave literal \` or \${ sequences in the script.
		expect(ANALYSIS_SCRIPT).not.toContain('\\`\\`');
		expect(ANALYSIS_SCRIPT).not.toContain('\\${');
		expect(ANALYSIS_SCRIPT).toContain('export const meta');
		expect(ANALYSIS_SCRIPT).toContain("name: 'trace-deep-analysis'");
		expect(ANALYSIS_SCRIPT).toContain('(v2)');
		expect(ANALYSIS_SCRIPT).toContain("phase('Collect')");
		expect(ANALYSIS_SCRIPT).toContain("phase('Verify')");
		expect(ANALYSIS_SCRIPT).toContain('schema: {');
	});

	it('keeps the TraceAnalysisReport contract the runs-page UI renders', () => {
		// The synthesis schema must be strict-compatible (all keys required)…
		expect(ANALYSIS_SCRIPT).toContain(
			"required: ['summary', 'healthScore', 'findings', 'improvements']"
		);
		// …and findings/improvements keep the exact enums the UI switches on.
		expect(ANALYSIS_SCRIPT).toContain("enum: ['performance', 'cost', 'reliability', 'quality']");
		expect(ANALYSIS_SCRIPT).toContain("enum: ['script', 'config', 'suggestion']");
		// Blind-grade lesson: high-severity findings are adversarially verified.
		expect(ANALYSIS_SCRIPT).toContain('ADVERSARIAL VERIFIER');
		// Ground-truth lesson: analysts must read per-turn transcripts.
		expect(ANALYSIS_SCRIPT).toContain('trace_get_llm_turn');
	});
});
