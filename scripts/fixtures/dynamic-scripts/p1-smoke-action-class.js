export const meta = {
	name: 'p1-smoke-action-class',
	description:
		'Cutover P1 proof (docs/code-first-cutover.md): action() + sleep() + approve() + named agent, end to end',
	phases: [{ title: 'Main' }],
	// meta.input (P1f): validated at start on every launch surface; the execute
	// dialog renders it as a generated form.
	input: {
		type: 'object',
		properties: {
			url: { type: 'string', default: 'https://example.com' },
			gateTimeoutMinutes: { type: 'number', default: 10 },
			namedAgent: { type: 'string', default: 'trace-analyst' },
		},
	},
}

phase('Main')

// 1. Deterministic action (P1b): non-AP slug via execute_action -> function-router.
//    allowFailure so a crawl hiccup still proves dispatch+journal without failing
//    the smoke; the returnValue records both outcomes.
const crawl = await action('web/crawl', { url: args.url }, { label: 'crawl', allowFailure: true })

// 2. Durable timer (P1b): journaled create_timer in the pump's when_any set.
await sleep(5)

// 3. Human approval gate (P1d): resolved via the approve route / a raise at the
//    wait_event child; timeout RESOLVES {timedOut:true} so the smoke never hangs.
const gate = await approve({ message: 'P1 smoke gate — approve me', timeoutMinutes: args.gateTimeoutMinutes })

// 4. Named agent (P1e): registered-slug resolution, fail-closed in the bridge.
const named = await agent('Reply with exactly: P1-SMOKE-OK', {
	agent: args.namedAgent,
	label: 'named-agent',
})

return {
	crawlDispatched: crawl !== undefined,
	crawlOk: !(crawl && crawl.success === false),
	gate,
	named: typeof named === 'string' ? named.slice(0, 120) : named,
}
