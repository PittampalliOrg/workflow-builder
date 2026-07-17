import { describe, it, expect } from 'vitest';
import { AGENT_MODEL_OPTIONS } from './model-options';
import { MODEL_GROUPS, groupModelOptions, groupedProviders } from './model-groups';

describe('model-groups', () => {
	it('covers every provider present in AGENT_MODEL_OPTIONS (no silently-dropped models)', () => {
		const covered = groupedProviders();
		const orphans = [
			...new Set(AGENT_MODEL_OPTIONS.map((o) => o.provider).filter((p) => !covered.has(p)))
		].sort();
		// An orphaned provider means its models never render in the picker — the
		// exact defect that hid GLM 5.2 (provider "zai").
		expect(orphans, `providers with no MODEL_GROUP: ${orphans.join(', ')}`).toEqual([]);
	});

	it('renders GLM 5.2 (zai/glm-5.2) in a group', () => {
		const glm = groupModelOptions()
			.flatMap((g) => g.options.map((o) => o.value))
			.filter((v) => v === 'zai/glm-5.2');
		expect(glm).toEqual(['zai/glm-5.2']);
	});

	it('renders only Kimi K3 in the Kimi selector group', () => {
		const kimi = groupModelOptions().find((group) => group.heading === 'Kimi');
		expect(kimi?.options.map((option) => option.value)).toEqual(['kimi/kimi-k3']);
	});

	it('assigns each model option to at most one group', () => {
		const counts = new Map<string, number>();
		for (const group of groupModelOptions()) {
			for (const opt of group.options) {
				counts.set(opt.value, (counts.get(opt.value) ?? 0) + 1);
			}
		}
		const duped = [...counts.entries()].filter(([, n]) => n > 1).map(([v]) => v);
		expect(duped, `models in multiple groups: ${duped.join(', ')}`).toEqual([]);
	});

	it('drops empty groups', () => {
		const headings = groupModelOptions().map((g) => g.heading);
		expect(headings.length).toBeLessThanOrEqual(MODEL_GROUPS.length);
		expect(new Set(headings).size).toBe(headings.length);
	});
});
