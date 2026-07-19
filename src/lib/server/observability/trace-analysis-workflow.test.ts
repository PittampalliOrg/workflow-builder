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

	it('uses Kimi K3 with max thinking at every agent call site', () => {
		const modelUses = ANALYSIS_SCRIPT.match(/model: 'kimi\/kimi-k3'/g) ?? [];
		const maxEffortUses = ANALYSIS_SCRIPT.match(/effort: 'max'/g) ?? [];
		expect(modelUses).toHaveLength(6);
		expect(maxEffortUses).toHaveLength(modelUses.length);
	});

	it('uses strict structured-output schemas throughout the harness', () => {
		expect(ANALYSIS_SCRIPT.match(/additionalProperties: false/g)?.length).toBeGreaterThanOrEqual(
			10
		);
		expect(ANALYSIS_SCRIPT).toContain(
			"required: ['status', 'durationSeconds', 'totalTokens', 'criticalPath', 'sessions', 'screenshots', 'issues']"
		);
		expect(ANALYSIS_SCRIPT).toContain(
			"required: ['sessionLabel', 'summary', 'whatWorked', 'whatFailed', 'quotes', 'classification', 'candidateFindings']"
		);
		expect(ANALYSIS_SCRIPT).toContain(
			"required: ['title', 'verdict', 'evidence', 'corrections']"
		);
	});

	it('samples transcript selectors safely and preserves an explicit zero verifier limit', () => {
		expect(ANALYSIS_SCRIPT).toContain("enum: ['session', 'span']");
		expect(ANALYSIS_SCRIPT).toContain(
			'pass sessionId when selectorType is session, or spanId when selectorType is span'
		);
		expect(ANALYSIS_SCRIPT).not.toContain('s.sessionId');
		expect(ANALYSIS_SCRIPT).toContain('Number.isFinite(requestedVerifiers)');
		expect(ANALYSIS_SCRIPT).toContain(
			'verifierCalls.length ? (await parallel(verifierCalls)).filter(Boolean) : []'
		);
	});

	it('keeps the TraceAnalysisReport contract the runs-page UI renders', () => {
		// The synthesis schema must be strict-compatible (all keys required).
		expect(ANALYSIS_SCRIPT).toContain(
			"required: ['summary', 'healthScore', 'findings', 'improvements']"
		);
		// Findings and improvements keep the exact enums the UI switches on.
		expect(ANALYSIS_SCRIPT).toContain("enum: ['performance', 'cost', 'reliability', 'quality']");
		expect(ANALYSIS_SCRIPT).toContain("enum: ['script', 'config', 'suggestion']");
		// Blind-grade lesson: high-severity findings are adversarially verified.
		expect(ANALYSIS_SCRIPT).toContain('ADVERSARIAL VERIFIER');
		// Ground-truth lesson: analysts must read per-turn transcripts.
		expect(ANALYSIS_SCRIPT).toContain('trace_get_llm_turn');
	});

	it('discovers native browser evidence and reserves budget for a final synthesis', () => {
		expect(ANALYSIS_SCRIPT).toContain('call debug_workflow_execution first');
		expect(ANALYSIS_SCRIPT).toContain('trace_get_browser_screenshot');
		expect(ANALYSIS_SCRIPT).toContain("label: 'analyze:browser-vision'");
		expect(ANALYSIS_SCRIPT).toContain('const SYNTHESIS_RESERVE = 70000');
		expect(ANALYSIS_SCRIPT).toContain('budget.total - mandatoryReserve');
		expect(ANALYSIS_SCRIPT).not.toContain('budget.remaining()');
	});
});
