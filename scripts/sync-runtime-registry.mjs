#!/usr/bin/env node
/**
 * Sync the canonical runtime registry to its build-context-local copies.
 *
 * Canonical SSOT: services/shared/runtime-registry.json
 * Generated copies (byte-identical; guarded by drift tests):
 *   - services/workflow-orchestrator/core/runtime_registry.json  (Python orchestrator reader)
 *   - src/lib/server/agents/runtime-registry.data.json           (TS BFF reader)
 *
 * Why copies: each service's Docker build context is its own subdir
 * (services/workflow-orchestrator, repo-root for the BFF), so neither can COPY a
 * shared services/shared/ file directly without risky build-context surgery.
 * This script keeps the copies in lockstep; `--check` fails (non-zero) on drift.
 *
 * Usage:
 *   node scripts/sync-runtime-registry.mjs          # write the copies
 *   node scripts/sync-runtime-registry.mjs --check  # CI: verify copies are in sync
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL = join(ROOT, 'services/shared/runtime-registry.json');
const COPIES = [
	join(ROOT, 'services/workflow-orchestrator/core/runtime_registry.json'),
	join(ROOT, 'src/lib/server/agents/runtime-registry.data.json')
];

const check = process.argv.includes('--check');
const canonical = readFileSync(CANONICAL, 'utf8');

// Validate the canonical parses and has the shape both readers expect.
const parsed = JSON.parse(canonical);
if (!Array.isArray(parsed.runtimes) || typeof parsed.dispatchWorkflowName !== 'string') {
	console.error('[sync-runtime-registry] canonical is malformed (missing runtimes[]/dispatchWorkflowName)');
	process.exit(1);
}

let drift = false;
for (const target of COPIES) {
	let current = '';
	try {
		current = readFileSync(target, 'utf8');
	} catch {
		current = '';
	}
	if (current === canonical) continue;
	drift = true;
	if (check) {
		console.error(`[sync-runtime-registry] DRIFT: ${target} is out of sync with the canonical`);
	} else {
		writeFileSync(target, canonical);
		console.log(`[sync-runtime-registry] wrote ${target}`);
	}
}

if (check && drift) {
	console.error('[sync-runtime-registry] run `node scripts/sync-runtime-registry.mjs` to fix.');
	process.exit(1);
}
if (!check && !drift) {
	console.log('[sync-runtime-registry] copies already in sync.');
}
