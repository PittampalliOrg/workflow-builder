import { describe, expect, it } from 'vitest';

import type { ObservabilityTraceSpan } from '$lib/types/observability';
import { buildIoFallbackBySpanId } from './io-fallback';

function span(
	spanId: string,
	parentSpanId: string | null,
	serviceName: string,
	operationName: string,
	attributes: Record<string, unknown> = {}
): ObservabilityTraceSpan {
	return {
		traceId: 'trace-1',
		spanId,
		parentSpanId,
		operationName,
		serviceName,
		startTime: '2026-05-22T11:00:00.000Z',
		duration: 1,
		status: 'ok',
		spanKind: 'Client',
		attributes,
		depth: 0
	};
}

describe('buildIoFallbackBySpanId', () => {
	it('uses descendant content for wrapper spans', () => {
		const wrapper = span('wrapper', null, 'function-router', 'POST /execute');
		const child = span('child', 'wrapper', 'openshell-agent-runtime', 'POST /api/workspaces/command', {
			'input.value': '{"command":"pwd"}',
			'output.value': '{"stdout":"/sandbox"}'
		});

		const fallback = buildIoFallbackBySpanId([wrapper, child]).get('wrapper');

		expect(fallback).toEqual({
			input: {
				sourceLabel: 'openshell-agent-runtime POST /api/workspaces/command',
				sourceRelation: 'descendant',
				value: '{"command":"pwd"}'
			},
			output: {
				sourceLabel: 'openshell-agent-runtime POST /api/workspaces/command',
				sourceRelation: 'descendant',
				value: '{"stdout":"/sandbox"}'
			}
		});
	});

	it('uses ancestor content for native Dapr child spans', () => {
		const stateWrapper = span('state.load_many', null, 'dapr-agent-py', 'state.load_many', {
			'input.value': '{"operation":"load_many","key":"agents:default:dapr-agent-py"}',
			'output.value': '{"agents":["dapr-agent-py"]}'
		});
		const nativeDaprSpan = span(
			'GetBulkState',
			'state.load_many',
			'dapr-agent-py',
			'/dapr.proto.runtime.v1.Dapr/GetBulkState'
		);

		const fallback = buildIoFallbackBySpanId([stateWrapper, nativeDaprSpan]).get('GetBulkState');

		expect(fallback).toEqual({
			input: {
				sourceLabel: 'dapr-agent-py state.load_many',
				sourceRelation: 'ancestor',
				value: '{"operation":"load_many","key":"agents:default:dapr-agent-py"}'
			},
			output: {
				sourceLabel: 'dapr-agent-py state.load_many',
				sourceRelation: 'ancestor',
				value: '{"agents":["dapr-agent-py"]}'
			}
		});
	});

	it('fills a missing response from the nearest contentful ancestor when a child already has input', () => {
		const route = span('execute', null, 'function-router', 'POST', {
			'input.value': '{"actionType":"workspace/profile"}',
			'output.value': '{"success":false,"error":"fetch failed","routed_to":"openshell-agent-runtime"}'
		});
		const clientCall = span(
			'profile-client',
			'execute',
			'function-router',
			'POST /api/workspaces/profile',
			{
				'input.value': '{"name":"three-b-one-b-animation"}'
			}
		);

		const fallback = buildIoFallbackBySpanId([route, clientCall]).get('profile-client');

		expect(fallback).toEqual({
			output: {
				sourceLabel: 'function-router POST',
				sourceRelation: 'ancestor',
				value: '{"success":false,"error":"fetch failed","routed_to":"openshell-agent-runtime"}'
			}
		});
	});

	it('treats empty string body attributes as missing so native wrapper spans can fall back', () => {
		const daprWrapper = span('call-local', null, 'function-router', 'CallLocal/function-router/execute', {
			'input.value': '',
			'output.value': ''
		});
		const fastifyServer = span('execute-server', 'call-local', 'function-router', 'POST', {
			'input.value': '{"function_slug":"workspace/command"}',
			'output.value': '{"success":true}'
		});

		const fallback = buildIoFallbackBySpanId([daprWrapper, fastifyServer]).get('call-local');

		expect(fallback).toEqual({
			input: {
				sourceLabel: 'function-router POST',
				sourceRelation: 'descendant',
				value: '{"function_slug":"workspace/command"}'
			},
			output: {
				sourceLabel: 'function-router POST',
				sourceRelation: 'descendant',
				value: '{"success":true}'
			}
		});
	});
});
