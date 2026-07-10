import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { specToGraph } from '../../../src/lib/utils/spec-graph-adapter';
import { PREVIEW_GAN_UI_FEATURE_CONFIG } from './gen/gan-config';
import { renderGanFixture } from './gen/gan-fixture-generator';

const fixturePath = resolve(
	process.cwd(),
	'scripts/fixtures/generator-critic/preview-gan-ui-feature.json'
);
const fixtureText = () => readFileSync(fixturePath, 'utf8');
const spec = () => JSON.parse(fixtureText());

describe('preview-gan-ui-feature fixture', () => {
	it('is byte-identical to the typed generator output (drift guard)', () => {
		// If this fails, run: tsx scripts/generate-gan-fixtures.ts
		expect(fixtureText()).toBe(renderGanFixture(PREVIEW_GAN_UI_FEATURE_CONFIG));
	});

	it('builds a valid canvas graph', () => {
		const g = specToGraph(spec());
		expect(g.nodes.length).toBeGreaterThan(5);
	});

	it('has the GAN UI-feature node sequence with a gated promote', () => {
		const ids = spec().do.map((n: any) => Object.keys(n)[0]);
		expect(ids).toEqual([
			'enter_dev_mode',
			'plan',
			'design_review',
			'refine',
			'promote',
			'summary'
		]);
		const refine = spec().do.find((n: any) => n.refine).refine;
		expect(refine.do.map((n: any) => Object.keys(n)[0])).toEqual([
			'generate',
			'gate',
			'snapshot',
			'critique',
			'read_verdict'
		]);
		const snapshot = refine.do.find((n: any) => n.snapshot).snapshot;
		expect(snapshot.call).toBe('dev/preview-snapshot');
		expect(snapshot.with.services).toEqual(['workflow-builder']);
	});

	it('runs a hardened, helper-pod-pinned deterministic gate that writes a machine-readable gate file', () => {
		const refine = spec().do.find((n: any) => n.refine).refine;
		const gate = refine.do.find((n: any) => n.gate).gate;
		expect(gate.call).toBe('workspace/command');
		expect(gate.with.cliWorkspace).toBe(true);
		// pinned to the cliws helper pod with a long lease
		expect(gate.with.helperPod).toBe(true);
		expect(gate.with.helperTimeoutMinutes).toBe(240);
		// pod-local scratch (not JuiceFS) + pnpm bootstrap guard + node_modules cache
		expect(gate.with.command).toContain('/sandbox/scratch/gate-repo');
		expect(gate.with.command).toContain('corepack enable');
		expect(gate.with.command).toContain('gate-node-modules.tar');
		expect(gate.with.command).toContain('SYNC_TOKEN=');
		expect(gate.with.command).toContain('x-sync-token: $SYNC_TOKEN');
		// runs all three phases and emits the per-idx gate file the read_verdict consumes
		expect(gate.with.command).toContain('pnpm check');
		expect(gate.with.command).toContain('pnpm check:boundaries');
		expect(gate.with.command).toContain('pnpm test:unit');
		expect(gate.with.command).toContain('gate-$IDX.json');
		expect(gate.with.command).toContain('OBJECTIVE PASS');
	});

	it('reads a FILE-FIRST verdict and derives the single-source-of-truth loop signal', () => {
		const refine = spec().do.find((n: any) => n.refine).refine;
		const readVerdict = refine.do.find((n: any) => n.read_verdict).read_verdict;
		expect(readVerdict.call).toBe('workspace/command');
		expect(readVerdict.with.helperPod).toBe(true);
		// file-first: verdict-<idx>.json, gate-<idx>.json, records verdict_source, computes stalled/accepted
		expect(readVerdict.with.command).toContain('verdict-$IDX.json');
		expect(readVerdict.with.command).toContain('gate-$IDX.json');
		expect(readVerdict.with.command).toContain('verdict_source');
		expect(readVerdict.with.command).toContain('stalled');
		expect(readVerdict.with.command).toContain('accepted');
	});

	it('breaks the loop ONLY from the read_verdict signal (accepted OR stalled), not raw gate/critique', () => {
		const refine = spec().do.find((n: any) => n.refine).refine;
		// while reads the read_verdict parsed stdout (.accepted / .stalled) and nothing else
		expect(refine.while).toContain('read_verdict');
		expect(refine.while).toContain('.accepted');
		expect(refine.while).toContain('.stalled');
		expect(refine.while).not.toContain('OBJECTIVE PASS');
		expect(refine.while).not.toContain('critique.meets_criteria');
		// iteration bound is configurable via .trigger.maxIterations (default 5)
		expect(refine.for.in).toContain('maxIterations');
	});

	it('instructs the critic to write a file verdict before its final message', () => {
		const refine = spec().do.find((n: any) => n.refine).refine;
		const critique = refine.do.find((n: any) => n.critique).critique;
		expect(critique.parseJson).toBe(true);
		expect(critique.with.agentConfig.instructions).toContain('strict JSON');
		// verdict-file-first convention in the prompt, with the schema + iteration keys
		expect(critique.with.body.prompt).toContain('verdict-');
		expect(critique.with.body.prompt).toContain('gan.verdict/v1');
		expect(critique.with.body.prompt).toContain('before your final message');
	});

	it('carries ecosystem scope: critic classifies in-app issues, read_verdict relays them, generator fixes them', () => {
		const refine = spec().do.find((n: any) => n.refine).refine;
		const critique = refine.do.find((n: any) => n.critique).critique;
		const readVerdict = refine.do.find((n: any) => n.read_verdict).read_verdict;
		const generate = refine.do.find((n: any) => n.generate).generate;
		// critic verdict schema v1 gains ecosystemIssues [{area,detail,suggestedFix}]
		// and a hard env-vs-ecosystem boundary
		expect(critique.with.body.prompt).toContain('ecosystemIssues');
		expect(critique.with.body.prompt).toContain('suggestedFix');
		expect(critique.with.body.prompt).toContain('HARD BOUNDARY');
		expect(critique.with.agentConfig.instructions).toContain('ecosystemIssues');
		// read_verdict serializes the (bounded) ecosystem list into its stdout JSON
		expect(readVerdict.with.command).toContain('ECOSYSTEM');
		expect(readVerdict.with.command).toContain('ecosystem');
		expect(readVerdict.with.command).toContain('1500');
		// generator gets an explicit ecosystem-scope mandate + the relayed list
		expect(generate.with.body.prompt).toContain('ECOSYSTEM SCOPE');
		expect(generate.with.body.prompt).toContain('Ecosystem issues flagged by the critic');
		expect(generate.with.body.prompt).toContain('.ecosystem');
	});

	it('promotes via the dev/preview-promote action (no inline git shell), draft when not accepted', () => {
		const promote = spec().do.find((n: any) => n.promote).promote;
		expect(promote.call).toBe('dev/preview-promote');
		expect(promote.with.services).toEqual(['workflow-builder']);
		expect(promote.if).toContain('outputMode');
		expect(promote.with.iteration).toBe('best');
		expect(promote.with).not.toHaveProperty('branchPrefix');
		expect(promote.with).not.toHaveProperty('repoUrl');
		expect(promote.with).not.toHaveProperty('baseBranch');
		// draft flag + [draft] title prefix are driven by read_verdict.accepted
		expect(promote.with.draft).toContain('read_verdict');
		expect(promote.with.title).toContain('[draft] ');
		expect(promote.with.bodyMarkdown).toContain('read_verdict');
		// no inline git/PR shell survives on this node
		expect(JSON.stringify(promote.with)).not.toContain('git push');
	});

	it('summary carries the promote error (not an empty string) when a PR was expected but none returned', () => {
		const summary = spec().do.find((n: any) => n.summary).summary;
		expect(summary.set.pullRequest).toContain('promote-failed');
		expect(summary.set.promoteOk).toContain('.promote.ok');
		expect(summary.set.terminalState).toContain('read_verdict');
		expect(summary.set.gatePass).toContain('read_verdict');
	});

	it('feeds the generator critic feedback from read_verdict only (no raw-node tojson) and anchors its role', () => {
		const s = spec();
		const refine = s.do.find((n: any) => n.refine).refine;
		const generate = refine.do.find((n: any) => n.generate).generate;
		const p = generate.with.body.prompt;
		expect(p).toContain('x-sync-generation');
		expect(p).toContain('x-sync-service');
		expect(p).toContain('x-sync-roots');
		expect(p).toContain('x-sync-token');
		expect(p).toContain('.enter_dev_mode.syncCapability');
		// role anchor so an unparsed/critic-voiced feedback blob can't role-drift it
		expect(p).toContain('You are the GENERATOR/builder');
		expect(p).toContain('Never write verdict files; never grade');
		// critic feedback is sourced from the parsed read_verdict stdout, never the
		// raw critique node; the raw-object `.loop.last.critique | tojson` fallback
		// is gone entirely (the only remaining tojson is the constructed
		// {email,password} sign-in payload, a field serialization — asserted below)
		expect(p).toContain('read_verdict');
		expect(p).not.toContain('.loop.last.critique');
		expect(p).not.toMatch(/critique[\s\S]{0,40}tojson/);
		// read_verdict carries a (truncated) feedback field for exactly this
		const readVerdict = refine.do.find((n: any) => n.read_verdict).read_verdict;
		expect(readVerdict.with.command).toContain('[:2000]');
		// authenticated-smoke recipe with LITERAL (jq-interpolated) credentials
		expect(p).toContain('/api/v1/auth/sign-in');
		expect(p).toContain('.trigger.previewLogin');
		expect(p).toContain('.trigger.previewPassword');
	});

	it('adopts the workflow-builder preview (adopt:true)', () => {
		const enter = spec().do.find((n: any) => n.enter_dev_mode).enter_dev_mode;
		expect(enter.with.adopt).toBe(true);
		expect(enter.with.timeoutSeconds).toBe(86400);
	});

	it('exposes the generic UI-feature inputs (incl. acceptScore/stallWindow) in both schema blocks', () => {
		const s = spec();
		for (const block of [
			s.document['x-workflow-builder'].input.schema.document.properties,
			s.input.schema.document.properties
		]) {
			expect(block.generatorAgent?.default).toBe('gan-generator-ultracode');
			expect(block.criticAgent?.default).toBe('gan-critic-claude');
			expect(block.previewLogin?.default).toBe('admin@example.com');
			expect(block.previewPassword?.default).toBe('developer');
			expect(block.maxIterations?.default).toBe(5);
			expect(block.acceptScore?.default).toBe(8);
			expect(block.stallWindow?.default).toBe(2);
			expect(block.outputMode?.default).toBe('pr');
			expect(block.evaluationRoutes?.default).toEqual(['/dashboard']);
			// generic: no baked route-redesign field
			expect(block.targetRoute).toBeUndefined();
		}
	});

	it('pins Opus 4.8 + ultracode effort on the planner and generator, and never self-checks via /__run', () => {
		const s = spec();
		const plan = s.do.find((n: any) => n.plan).plan;
		const refine = s.do.find((n: any) => n.refine).refine;
		const generate = refine.do.find((n: any) => n.generate).generate;
		for (const node of [plan, generate]) {
			expect(node.with.agentConfig.modelSpec).toBe('claude-opus-4-8');
			expect(node.with.agentConfig.effort).toBe('ultracode');
			expect(node.with.agentRef.slug).toContain('gan-generator-ultracode');
			// the stale "self-check via /__run" phrasing is gone; instructions say never call it
			expect(node.with.agentConfig.instructions).not.toContain('self-check via /__run');
			expect(node.with.agentConfig.instructions).toContain('NEVER call /__run');
		}
	});
});
