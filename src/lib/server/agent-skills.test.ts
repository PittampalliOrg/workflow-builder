import { describe, expect, it } from 'vitest';
import { listAgentSkills } from './agent-skills';

describe('agent skill registry', () => {
	it('does not expose code-defined default skills when the database is unavailable', async () => {
		const skills = await listAgentSkills();
		expect(skills).toEqual([]);
	});
});
