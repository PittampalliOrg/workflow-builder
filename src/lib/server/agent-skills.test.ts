import { describe, expect, it } from 'vitest';
import { listAgentSkills, mergeAgentSkillRegistryEntries, parseSkillMarkdown } from './agent-skills';

describe('agent skill registry', () => {
	it('parses Agent Skills-compatible SKILL.md frontmatter', () => {
		const parsed = parseSkillMarkdown(
			`---
name: Demo Skill
description: Helps with demo work.
allowed-tools:
  - read_file
  - execute_command
arguments:
  - topic
argument-hint: Describe the topic
---
Follow the demo process for \${ARGUMENTS}.`,
			{
				sourceRepo: 'https://github.com/vercel-labs/agent-skills',
				sourceRef: 'main',
				skillPath: 'skills/demo/SKILL.md'
			}
		);

		expect(parsed.skill.name).toBe('demo-skill');
		expect(parsed.skill.description).toBe('Helps with demo work.');
		expect(parsed.skill.allowedTools).toEqual(['read_file', 'execute_command']);
		expect(parsed.skill.arguments).toEqual(['topic']);
		expect(parsed.skill.argumentHint).toBe('Describe the topic');
		expect(parsed.skill.prompt).toContain('${ARGUMENTS}');
		expect(parsed.skill.packageManifest?.schemaVersion).toBe(1);
		expect(Array.isArray(parsed.skill.packageManifest?.files)).toBe(true);
		expect((parsed.skill.packageManifest?.files as Array<{ path: string }>)[0].path).toBe('SKILL.md');
		expect(parsed.contentHash).toMatch(/^sha256:/);
	});

	it('rejects skill packages without a non-empty body', () => {
		expect(() =>
			parseSkillMarkdown(`---\nname: empty\ndescription: Empty skill\n---\n`)
		).toThrow('Skill body must not be empty');
	});

	it('returns curated skills when the database is unavailable', async () => {
		const skills = await listAgentSkills();
		expect(skills.map((skill) => skill.name)).toContain('simplify');
		expect(skills.map((skill) => skill.name)).toContain('ai-sdk');
		expect(skills.every((skill) => skill.status === 'ENABLED')).toBe(true);
	});

	it('lets registry rows override curated skill status and package metadata', () => {
		const merged = mergeAgentSkillRegistryEntries([
			{
				id: 'builtin:simplify',
				registryId: 'builtin:simplify',
				slug: 'simplify',
				name: 'simplify',
				description: 'Disabled override',
				prompt: 'Disabled override',
				status: 'DISABLED',
				sourceType: 'builtin',
				contentHash: 'override',
				version: '2'
			},
			{
				id: 'imported:demo',
				registryId: 'imported:demo',
				slug: 'demo',
				name: 'demo',
				description: 'Imported demo',
				prompt: 'Use package files.',
				status: 'ENABLED',
				sourceType: 'imported',
				contentHash: 'sha256:demo',
				version: '1',
				packageManifest: {
					schemaVersion: 1,
					files: [{ path: 'references/demo.md', content: 'demo', size: 4, encoding: 'utf-8' }]
				}
			}
		]);

		const simplify = merged.find((skill) => skill.slug === 'simplify');
		const demo = merged.find((skill) => skill.slug === 'demo');
		expect(simplify?.status).toBe('DISABLED');
		expect(simplify?.version).toBe('2');
		expect(demo?.packageManifest?.files).toHaveLength(1);
	});
});
