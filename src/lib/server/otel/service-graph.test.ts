import { describe, expect, it } from 'vitest';
import type { ObservabilityTraceSpan } from '$lib/types/observability';
import {
	buildServiceGraphFromSpans,
	buildStepGraphDynamicScript,
	isBenignControlPlaneError,
	virtualPeer
} from './service-graph';

function span(overrides: Partial<ObservabilityTraceSpan>): ObservabilityTraceSpan {
	return {
		traceId: 'trace-1',
		spanId: 'span-1',
		parentSpanId: null,
		operationName: 'GET /',
		serviceName: 'service-a',
		startTime: '2026-05-22T00:00:00.000Z',
		duration: 1,
		status: 'error',
		statusCode: 'Error',
		spanKind: 'Server',
		depth: 0,
		...overrides
	};
}

describe('service graph error classification', () => {
	it('does not mark known Dapr control-plane shutdown spans as workflow errors', () => {
		const spans = [
			span({
				spanId: 'sub-1',
				operationName: '/dapr.proto.runtime.v1.Dapr/SubscribeTopicEventsAlpha1',
				serviceName: 'agent-session-1234567890abcdef',
				statusMessage: 'context canceled'
			}),
			span({
				spanId: 'app-1',
				operationName: 'POST /execute',
				serviceName: 'function-router',
				statusMessage: 'HTTP 500'
			})
		];

		expect(isBenignControlPlaneError(spans[0])).toBe(true);
		expect(isBenignControlPlaneError(spans[1])).toBe(false);

		const graph = buildServiceGraphFromSpans(spans);
		const agent = graph.nodes.find((node) => node.id === 'agent-session');
		const router = graph.nodes.find((node) => node.id === 'function-router');

		expect(agent?.red.errors).toBe(0);
		expect(agent?.status).toBe('ok');
		expect(router?.red.errors).toBe(1);
		expect(router?.status).toBe('error');
	});
});

describe('service graph virtual peers', () => {
	it('recognizes stable OpenTelemetry database semantic conventions', () => {
		const peer = virtualPeer(
			span({
				spanKind: 'Client',
				status: 'ok',
				statusCode: 'Ok',
				attributes: {
					'db.system.name': 'postgresql'
				}
			})
		);

		expect(peer).toEqual({ id: 'db:postgresql', kind: 'db', label: 'postgresql' });
	});

	it('builds database edges from db.system.name spans', () => {
		const graph = buildServiceGraphFromSpans([
			span({
				spanKind: 'Client',
				status: 'ok',
				statusCode: 'Ok',
				attributes: {
					'db.system.name': 'postgresql'
				}
			})
		]);

		expect(graph.nodes.some((node) => node.id === 'db:postgresql' && node.kind === 'db')).toBe(true);
		expect(graph.edges.some((edge) => edge.source === 'service-a' && edge.target === 'db:postgresql')).toBe(true);
	});
});

describe('dynamic-script step graph (journal-backed)', () => {
	const call = (over: Partial<Parameters<typeof buildStepGraphDynamicScript>[0][number]>) => ({
		callId: 'c0',
		seq: 0,
		kind: 'agent',
		label: null,
		phase: null,
		status: 'done',
		sessionId: null,
		retries: 0,
		errorCode: null,
		...over
	});
	const span = (over: Partial<ObservabilityTraceSpan>): ObservabilityTraceSpan =>
		({
			traceId: 't1',
			spanId: Math.random().toString(16).slice(2, 10),
			parentSpanId: null,
			operationName: 'op',
			serviceName: 'dapr-agent-py',
			startTime: new Date(1_700_000_000_000).toISOString(),
			duration: 1000,
			status: 'Unset',
			depth: 0,
			attributes: {},
			...over
		}) as ObservabilityTraceSpan;

	it('builds phase-laned nodes with per-session span timing', () => {
		const calls = [
			call({ callId: 'a', seq: 0, phase: 'Brainstorm', label: 'pro', sessionId: 's-a' }),
			call({ callId: 'b', seq: 1, phase: 'Brainstorm', label: 'con', sessionId: 's-b' }),
			call({ callId: 'j', seq: 2, phase: 'Verdict', label: 'judge', sessionId: 's-j', status: 'running' })
		];
		const spans = [
			span({ attributes: { 'session.id': 's-a' }, startTime: new Date(1000).toISOString(), duration: 500 }),
			span({ attributes: { 'session.id': 's-a' }, startTime: new Date(2000).toISOString(), duration: 1500 })
		];
		const { nodes, edges, insights } = buildStepGraphDynamicScript(calls, spans, []);

		expect(nodes.map((n) => n.id)).toEqual(['a', 'b', 'j']);
		const a = nodes[0];
		expect(a.group).toBe('Brainstorm');
		expect(a.detail).toBe('agent');
		// span window: 1000 → 3500 = 2500ms
		expect(a.red.selfMs).toBe(2500);
		const j = nodes[2];
		expect(j.live).toBe(true);
		expect(j.sessionId).toBe('s-j');
		// dataflow: both Brainstorm calls feed the Verdict call
		expect(edges.map((e) => e.id).sort()).toEqual(['a__j', 'b__j']);
		expect(insights.criticalPath?.length).toBeGreaterThan(0);
	});

	it('attributes LLM tokens + retries to the owning call', () => {
		const calls = [
			call({ callId: 'a', seq: 0, phase: 'P', sessionId: 's-a', retries: 2, errorCode: 'boom', status: 'error' })
		];
		const llm = [
			{
				sessionId: 's-a',
				spanId: 'x',
				traceId: 't1',
				promptTokens: 100,
				completionTokens: 50,
				totalTokens: 150,
				modelName: 'glm-5.2'
			} as never
		];
		const { nodes, insights } = buildStepGraphDynamicScript(calls, [], llm);
		expect(nodes[0].status).toBe('error');
		expect(insights.nodes['a'].tokens?.total).toBe(150);
		expect(insights.nodes['a'].retries).toBe(2);
		expect(insights.nodes['a'].errorSamples?.[0].message).toBe('boom');
	});

	it('caps mesh edges on wide fan-outs', () => {
		const wide = Array.from({ length: 8 }, (_, i) =>
			call({ callId: `w${i}`, seq: i, phase: 'A', sessionId: `s${i}` })
		);
		const next = Array.from({ length: 8 }, (_, i) =>
			call({ callId: `n${i}`, seq: 8 + i, phase: 'B', sessionId: `t${i}` })
		);
		const { edges } = buildStepGraphDynamicScript([...wide, ...next], [], []);
		// 8×8=64 > cap → single representative edge
		expect(edges).toHaveLength(1);
	});
});
