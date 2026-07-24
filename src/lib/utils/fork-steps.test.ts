import { describe, expect, it } from 'vitest';
import { buildForkSteps, splitAtFork, summarizeReuse, type ScriptCallLike } from './fork-steps';

describe('buildForkSteps', () => {
	it('builds bare SW steps with no usage', () => {
		const steps = buildForkSteps(['plan', 'build', 'test'], null, 'build');
		expect(steps).toEqual([
			{ id: 'plan', label: 'plan', index: 0, tokens: null, isFailed: false },
			{ id: 'build', label: 'build', index: 1, tokens: null, isFailed: true },
			{ id: 'test', label: 'test', index: 2, tokens: null, isFailed: false }
		]);
	});

	it('augments dynamic-script steps with per-call tokens in seq order', () => {
		const calls: ScriptCallLike[] = [
			{ label: 'analyze', seq: 2, tokensUsed: 200, status: 'completed' },
			{ label: 'gather', seq: 1, tokensUsed: 100, status: 'completed' }
		];
		const steps = buildForkSteps(['n0', 'n1'], calls);
		expect(steps[0]).toMatchObject({ id: 'n0', label: 'gather', tokens: 100 });
		expect(steps[1]).toMatchObject({ id: 'n1', label: 'analyze', tokens: 200 });
	});
});

describe('summarizeReuse', () => {
	it('is empty at the first step', () => {
		const steps = buildForkSteps(['a', 'b', 'c'], null);
		expect(summarizeReuse(steps, 0)).toEqual({ stepCount: 0, tokens: null });
	});

	it('sums tokens of the skipped prefix when usage is known', () => {
		const calls: ScriptCallLike[] = [
			{ label: 'a', seq: 1, tokensUsed: 100, status: 'completed' },
			{ label: 'b', seq: 2, tokensUsed: 250, status: 'completed' },
			{ label: 'c', seq: 3, tokensUsed: 50, status: 'completed' }
		];
		const steps = buildForkSteps(['a', 'b', 'c'], calls);
		expect(summarizeReuse(steps, 2)).toEqual({ stepCount: 2, tokens: 350 });
	});

	it('reports step count with null tokens when usage is absent (SW runs)', () => {
		const steps = buildForkSteps(['a', 'b', 'c'], null);
		expect(summarizeReuse(steps, 2)).toEqual({ stepCount: 2, tokens: null });
	});
});

describe('splitAtFork', () => {
	it('splits skipped vs re-run at the selected step', () => {
		const steps = buildForkSteps(['a', 'b', 'c'], null);
		const { skipped, rerun, selectedIndex } = splitAtFork(steps, 'b');
		expect(skipped.map((s) => s.id)).toEqual(['a']);
		expect(rerun.map((s) => s.id)).toEqual(['b', 'c']);
		expect(selectedIndex).toBe(1);
	});

	it('re-runs everything when no fork point resolves', () => {
		const steps = buildForkSteps(['a', 'b'], null);
		expect(splitAtFork(steps, null).rerun.map((s) => s.id)).toEqual(['a', 'b']);
		expect(splitAtFork(steps, 'missing').selectedIndex).toBe(-1);
	});
});
