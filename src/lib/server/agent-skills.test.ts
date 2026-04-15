import { describe, expect, it } from 'vitest';
import { listAgentSkills, parseSkillSearchOutput, skillsCliEnv } from './agent-skills';

describe('agent skill registry', () => {
	it('does not expose code-defined default skills when the database is unavailable', async () => {
		const skills = await listAgentSkills();
		expect(skills).toEqual([]);
	});

	it('parses skills.sh CLI search output', () => {
		const skills = parseSkillSearchOutput(`
\u001b[38;5;145mvercel-labs/agent-skills@web-design-guidelines\u001b[0m \u001b[36m255K installs\u001b[0m
\u001b[38;5;102m- https://skills.sh/vercel-labs/agent-skills/web-design-guidelines\u001b[0m

\u001b[38;5;145msveltejs/ai-tools@svelte-code-writer\u001b[0m \u001b[36m3.8K installs\u001b[0m
\u001b[38;5;102m- https://skills.sh/sveltejs/ai-tools/svelte-code-writer\u001b[0m
		`);

		expect(skills).toMatchObject([
			{
				name: 'web-design-guidelines',
				installSource: 'vercel-labs/agent-skills',
				skillName: 'web-design-guidelines',
				registryUrl: 'https://skills.sh/vercel-labs/agent-skills/web-design-guidelines',
				installs: '255K'
			},
			{
				name: 'svelte-code-writer',
				installSource: 'sveltejs/ai-tools',
				skillName: 'svelte-code-writer',
				registryUrl: 'https://skills.sh/sveltejs/ai-tools/svelte-code-writer',
				installs: '3.8K'
			}
		]);
	});

	it('uses writable npm cache defaults when the runtime home is root', () => {
		const env = skillsCliEnv({ HOME: '/' });

		expect(env.HOME).toBe('/tmp/workflow-builder-skills');
		expect(env.NPM_CONFIG_CACHE).toBe('/tmp/workflow-builder-skills/.npm');
		expect(env.npm_config_cache).toBe('/tmp/workflow-builder-skills/.npm');
		expect(env.XDG_CACHE_HOME).toBe('/tmp/workflow-builder-skills/.cache');
	});
});
