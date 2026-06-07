#!/usr/bin/env node
/**
 * Sync canonical cross-service shared assets to their build-context-local copies.
 *
 * Each Python/TS service's Docker build context is its own subdir
 * (services/workflow-orchestrator, services/dapr-agent-py, ..., repo-root for the
 * BFF), so none can COPY a shared services/shared/ file directly without risky
 * build-context surgery. We vendor byte-identical copies in-tree instead and keep
 * them in lockstep here; `--check` fails (non-zero) on drift (run in CI + by the
 * vitest drift guards).
 *
 * Assets:
 *   1. runtime registry (SSOT: services/shared/runtime-registry.json)
 *        → services/workflow-orchestrator/core/runtime_registry.json  (Python orchestrator)
 *        → src/lib/server/agents/runtime-registry.data.json           (TS BFF)
 *   2. session-event publisher (SSOT: services/shared/session_events/publisher.py)
 *        → services/dapr-agent-py/src/event_publisher.py              (Python agent runtime)
 *        → services/claude-agent-py/src/event_publisher.py            (Python agent runtime)
 *
 * Usage:
 *   node scripts/sync-runtime-registry.mjs          # write the copies
 *   node scripts/sync-runtime-registry.mjs --check  # CI: verify copies are in sync
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (rel) => join(ROOT, rel);

/** @type {{name: string, canonical: string, copies: string[], validate?: (raw: string) => void}[]} */
const ASSETS = [
	{
		name: 'runtime-registry',
		canonical: p('services/shared/runtime-registry.json'),
		copies: [
			p('services/workflow-orchestrator/core/runtime_registry.json'),
			p('src/lib/server/agents/runtime-registry.data.json')
		],
		validate(raw) {
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed.runtimes) || typeof parsed.dispatchWorkflowName !== 'string') {
				throw new Error('missing runtimes[]/dispatchWorkflowName');
			}
		}
	},
	{
		name: 'session-event-publisher',
		canonical: p('services/shared/session_events/publisher.py'),
		copies: [
			p('services/dapr-agent-py/src/event_publisher.py'),
			p('services/claude-agent-py/src/event_publisher.py')
		],
		validate(raw) {
			// Cheap structural guard — the vendored copy must keep the symbols
			// every call-site imports + the incremental-tier gate.
			for (const sym of ['def publish_session_event(', 'INCREMENTAL_EVENTS_ENABLED', 'def set_incremental_tier_enabled(']) {
				if (!raw.includes(sym)) throw new Error(`canonical missing "${sym}"`);
			}
		}
	}
];

const check = process.argv.includes('--check');
let drift = false;

for (const asset of ASSETS) {
	const canonical = readFileSync(asset.canonical, 'utf8');
	if (asset.validate) {
		try {
			asset.validate(canonical);
		} catch (err) {
			console.error(`[sync-runtime-registry] ${asset.name} canonical is malformed: ${err.message}`);
			process.exit(1);
		}
	}
	for (const target of asset.copies) {
		let current = '';
		try {
			current = readFileSync(target, 'utf8');
		} catch {
			current = '';
		}
		if (current === canonical) continue;
		drift = true;
		if (check) {
			console.error(`[sync-runtime-registry] DRIFT: ${target} is out of sync with ${asset.name} canonical`);
		} else {
			writeFileSync(target, canonical);
			console.log(`[sync-runtime-registry] wrote ${target}`);
		}
	}
}

if (check && drift) {
	console.error('[sync-runtime-registry] run `node scripts/sync-runtime-registry.mjs` to fix.');
	process.exit(1);
}
if (!check && !drift) {
	console.log('[sync-runtime-registry] copies already in sync.');
}
