import { describe, expect, it } from 'vitest';
import { normalizeDoArray, extractTriggerSchema, getWorkflowName, markJqExpressions } from './normalize';
import { classifyJq } from './jq-to-lang';
import { summarizeComposition, type EmitWorkflowInput } from './ir';
import { emitTypeScript } from './emit-ts';
import { emitPython } from './emit-py';

const shimTs = 'export class WorkflowContext {}';
const shimPy = 'class WorkflowContext: pass';

function makeInput(steps: EmitWorkflowInput['steps']): EmitWorkflowInput {
	return {
		steps,
		workflowName: 'test workflow',
		triggerSchema: null,
		inlinedFunctions: [],
		warnings: [],
		originalSpec: { document: { dsl: '1.0.0', name: 'test' }, do: [] },
	};
}

describe('normalizeDoArray', () => {
	it('turns a call task into a CallNode', () => {
		const warnings: string[] = [];
		const steps = normalizeDoArray(
			[{ fetchUser: { call: 'openai/chat', with: { model: 'gpt-4' } } }],
			warnings,
		);
		expect(steps).toHaveLength(1);
		expect(steps[0]).toMatchObject({ kind: 'call', slug: 'openai/chat' });
		expect(warnings).toHaveLength(0);
	});

	it('marks fork/listen/emit as passthrough with a warning', () => {
		const warnings: string[] = [];
		const steps = normalizeDoArray(
			[{ parallel: { fork: { branches: [] } } }],
			warnings,
		);
		expect(steps[0].kind).toBe('passthrough');
		expect(warnings.length).toBeGreaterThan(0);
	});

	it('durable/run is always passthrough', () => {
		const warnings: string[] = [];
		const steps = normalizeDoArray(
			[{ agent: { call: 'durable/run', with: { prompt: 'hi' } } }],
			warnings,
		);
		expect(steps[0]).toMatchObject({ kind: 'passthrough', taskKind: 'durable/run' });
	});

	it('normalizes for-loop body recursively', () => {
		const warnings: string[] = [];
		const steps = normalizeDoArray(
			[
				{
					loop: {
						for: {
							each: 'item',
							in: '${ .items }',
							do: [{ inner: { call: 'system/http-request', with: {} } }],
						},
					},
				},
			],
			warnings,
		);
		expect(steps[0].kind).toBe('for');
		if (steps[0].kind === 'for') {
			expect(steps[0].body).toHaveLength(1);
			expect(steps[0].body[0].kind).toBe('call');
		}
	});
});

describe('markJqExpressions', () => {
	it('replaces ${ ... } strings with markers', () => {
		const result = markJqExpressions({ a: '${ .x }', b: 'literal' });
		expect(result).toEqual({ a: { __jq: '.x' }, b: 'literal' });
	});

	it('recurses into arrays', () => {
		const result = markJqExpressions(['${ .a }', 'b']);
		expect(result).toEqual([{ __jq: '.a' }, 'b']);
	});
});

describe('classifyJq', () => {
	it('accepts simple path access', () => {
		expect(classifyJq('.count > 10').supported).toBe(true);
	});
	it('rejects map()', () => {
		expect(classifyJq('.items | map(.id)').supported).toBe(false);
	});
	it('rejects reduce', () => {
		expect(classifyJq('reduce .items[] as $i (0; . + $i)').supported).toBe(false);
	});
});

describe('summarizeComposition', () => {
	it('collects activity slugs and flags', () => {
		const composition = summarizeComposition([
			{ kind: 'call', taskName: 'a', slug: 'openai/chat', args: {} },
			{ kind: 'call', taskName: 'b', slug: 'system/http-request', args: {} },
			{
				kind: 'switch',
				taskName: 'branch',
				cases: [{ when: '.x', then: 'end' }],
			},
			{
				kind: 'passthrough',
				taskName: 'parallel',
				taskKind: 'fork',
				raw: {},
				reason: 'test',
			},
		]);
		expect(composition.activitySlugs).toEqual([
			'openai/chat',
			'system/http-request',
		]);
		expect(composition.hasSwitch).toBe(true);
		expect(composition.hasFork).toBe(true);
		expect(composition.hasDurableAgent).toBe(false);
	});

	it('detects durable/run agents in calls and passthroughs', () => {
		const composition = summarizeComposition([
			{
				kind: 'passthrough',
				taskName: 'agent',
				taskKind: 'durable/run',
				raw: {},
				reason: 'test',
			},
		]);
		expect(composition.hasDurableAgent).toBe(true);
	});
});

describe('emitTypeScript', () => {
	it('emits a call task with ctx.callActivity', () => {
		const result = emitTypeScript(
			makeInput([
				{ kind: 'call', taskName: 'fetch_user', slug: 'openai/chat', args: { model: 'gpt-4' } },
			]),
			shimTs,
		);
		expect(result.source).toContain('export async function main');
		expect(result.source).toContain('const fetch_user = await ctx.callActivity("openai/chat"');
		expect(result.supportingFiles['runtime.ts']).toBe(shimTs);
	});

	it('emits jq expressions as ctx.jq calls', () => {
		const result = emitTypeScript(
			makeInput([
				{ kind: 'call', taskName: 'greet', slug: 'openai/chat', args: { prompt: '${ .trigger.userQuery }' } },
			]),
			shimTs,
		);
		expect(result.source).toContain('ctx.jq(".trigger.userQuery")');
	});

	it('emits switch as if/else chain', () => {
		const result = emitTypeScript(
			makeInput([
				{
					kind: 'switch',
					taskName: 'branch',
					cases: [
						{ when: '.count > 10', then: 'end' },
						{ when: null, then: 'continue' },
					],
				},
			]),
			shimTs,
		);
		expect(result.source).toContain('if (await ctx.jqBool(".count > 10"))');
		expect(result.source).toContain('else {');
	});

	it('emits for-loop with ctx.jqArray', () => {
		const result = emitTypeScript(
			makeInput([
				{
					kind: 'for',
					taskName: 'loop',
					each: 'item',
					in: '.items',
					body: [{ kind: 'call', taskName: 'inner', slug: 'system/http-request', args: {} }],
				},
			]),
			shimTs,
		);
		expect(result.source).toContain('for (const item of await ctx.jqArray(".items"))');
		expect(result.source).toContain('const inner = await ctx.callActivity("system/http-request"');
	});

	it('emits try/catch', () => {
		const result = emitTypeScript(
			makeInput([
				{
					kind: 'try',
					taskName: 'safe',
					tryBody: [{ kind: 'call', taskName: 'x', slug: 'flaky/op', args: {} }],
					catchBody: [{ kind: 'call', taskName: 'r', slug: 'recover/op', args: {} }],
					catchWhen: null,
				},
			]),
			shimTs,
		);
		expect(result.source).toContain('try {');
		expect(result.source).toContain('} catch (e) {');
		expect(result.source).toContain('const r = await ctx.callActivity("recover/op"');
	});

	it('embeds the original spec for round-trip recovery', () => {
		const input = makeInput([]);
		input.originalSpec = { document: { name: 'rt' }, do: [{ a: { call: 'test/x', with: {} } }] };
		const result = emitTypeScript(input, shimTs);
		expect(result.source).toContain('__workflowSpec');
		expect(result.source).toContain('"test/x"');
	});

	it('surfaces inlined function as direct call', () => {
		const input = makeInput([
			{
				kind: 'call',
				taskName: 'parse',
				slug: 'code/parse-user-input',
				args: { raw: '${ .trigger.text }' },
				inlined: {
					identifier: 'parseUserInput',
					sourceSnippet: 'export async function parseUserInput(args) { return args.raw; }',
					slug: 'parse-user-input',
					version: '0.1.0',
					sha: 'abc12345',
					language: 'typescript',
					supportingFiles: {},
				},
			},
		]);
		input.inlinedFunctions = [input.steps[0] as { inlined: NonNullable<import('./ir').CallNode['inlined']> }].map((n) => n.inlined!);
		const result = emitTypeScript(input, shimTs);
		expect(result.source).toContain('export async function parseUserInput');
		expect(result.source).toContain('const parse = await parseUserInput(');
		expect(result.source).toContain('sha1:abc12345');
	});
});

describe('emitPython', () => {
	it('emits async def and call_activity', () => {
		const result = emitPython(
			makeInput([
				{ kind: 'call', taskName: 'fetch_user', slug: 'openai/chat', args: { model: 'gpt-4' } },
			]),
			shimPy,
		);
		expect(result.source).toContain('async def main');
		expect(result.source).toContain("fetch_user = await ctx.call_activity('openai/chat'");
		expect(result.supportingFiles['runtime.py']).toBe(shimPy);
	});

	it('emits for-loop with async iteration', () => {
		const result = emitPython(
			makeInput([
				{
					kind: 'for',
					taskName: 'loop',
					each: 'item',
					in: '.items',
					body: [{ kind: 'call', taskName: 'inner', slug: 'system/http-request', args: {} }],
				},
			]),
			shimPy,
		);
		expect(result.source).toContain('for item in await ctx.jq_array');
	});

	it('emits try/except', () => {
		const result = emitPython(
			makeInput([
				{
					kind: 'try',
					taskName: 'safe',
					tryBody: [{ kind: 'call', taskName: 'x', slug: 'flaky/op', args: {} }],
					catchBody: null,
					catchWhen: null,
				},
			]),
			shimPy,
		);
		expect(result.source).toContain('try:');
		expect(result.source).toContain('except Exception as e:');
	});
});

describe('trigger schema extraction', () => {
	it('reads from legacy spec.input', () => {
		const spec = { input: { schema: { document: { type: 'object', properties: { x: { type: 'string' } } } } } };
		const schema = extractTriggerSchema(spec);
		expect(schema).toMatchObject({ type: 'object' });
	});

	it('reads from x-workflow-builder extension', () => {
		const spec = {
			document: {
				'x-workflow-builder': {
					input: { schema: { type: 'object', properties: { y: { type: 'number' } } } },
				},
			},
		};
		const schema = extractTriggerSchema(spec);
		expect(schema).toMatchObject({ type: 'object' });
	});

	it('returns null when no schema is declared', () => {
		expect(extractTriggerSchema({ document: {} })).toBeNull();
	});
});

describe('getWorkflowName', () => {
	it('prefers document.title', () => {
		expect(
			getWorkflowName({ document: { title: 'My Flow', name: 'my-flow' } }),
		).toBe('My Flow');
	});

	it('falls back to document.name', () => {
		expect(getWorkflowName({ document: { name: 'the-flow' } })).toBe('the-flow');
	});

	it('defaults when absent', () => {
		expect(getWorkflowName({})).toBe('workflow');
	});
});
