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
 *        → services/cli-agent-py/src/event_publisher.py               (Python agent runtime)
 *   3. capability compiler (SSOT: services/shared/capability_compiler/) — a PACKAGE,
 *        vendored as a directory tree (package .py modules only; tests/ + __pycache__
 *        excluded). `--check` detects content drift AND file adds/removes both ways.
 *        → services/dapr-agent-py/src/capability_compiler/            (Python agent runtime)
 *        → services/claude-agent-py/src/capability_compiler/          (Python agent runtime)
 *        → services/cli-agent-py/src/capability_compiler/             (Python agent runtime)
 *
 * Usage:
 *   node scripts/sync-runtime-registry.mjs          # write the copies
 *   node scripts/sync-runtime-registry.mjs --check  # CI: verify copies are in sync
 */
import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	rmSync,
	readdirSync,
	existsSync
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (rel) => join(ROOT, rel);

/** @type {{name: string, canonical: string, copies: string[], validate?: (raw: string) => void}[]} */
const FILE_ASSETS = [
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
			p('services/claude-agent-py/src/event_publisher.py'),
			p('services/cli-agent-py/src/event_publisher.py')
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

/** @type {{name: string, canonicalDir: string, copyDirs: string[], validate?: (files: Map<string, Buffer>) => void}[]} */
const DIR_ASSETS = [
	{
		name: 'capability-compiler',
		canonicalDir: p('services/shared/capability_compiler'),
		copyDirs: [
			p('services/dapr-agent-py/src/capability_compiler'),
			p('services/claude-agent-py/src/capability_compiler'),
			p('services/cli-agent-py/src/capability_compiler')
		],
		validate(files) {
			const mcp = files.get('mcp.py')?.toString('utf8') ?? '';
			for (const sym of ['def emit_dapr_agent_py(', 'def emit_claude_code_cli_servers(', 'def emit_claude_agent_sdk_servers(']) {
				if (!mcp.includes(sym)) throw new Error(`canonical mcp.py missing "${sym}"`);
			}
		}
	}
];

// Package .py modules only — tests/ and __pycache__ are canonical-only.
function listPackageFiles(dir) {
	const out = [];
	const walk = (cur) => {
		for (const entry of readdirSync(cur, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (entry.name === 'tests' || entry.name === '__pycache__') continue;
				walk(join(cur, entry.name));
			} else if (entry.isFile() && entry.name.endsWith('.py')) {
				out.push(relative(dir, join(cur, entry.name)).split(sep).join('/'));
			}
		}
	};
	walk(dir);
	return out.sort();
}

const check = process.argv.includes('--check');
let drift = false;

for (const asset of FILE_ASSETS) {
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

for (const asset of DIR_ASSETS) {
	const rels = listPackageFiles(asset.canonicalDir);
	const canonical = new Map(rels.map((r) => [r, readFileSync(join(asset.canonicalDir, r))]));
	if (asset.validate) {
		try {
			asset.validate(canonical);
		} catch (err) {
			console.error(`[sync-runtime-registry] ${asset.name} canonical is malformed: ${err.message}`);
			process.exit(1);
		}
	}
	const canonSet = new Set(rels);
	for (const target of asset.copyDirs) {
		// Content adds/changes (canonical → vendored).
		for (const rel of rels) {
			const want = canonical.get(rel);
			const dst = join(target, rel);
			let cur = null;
			try {
				cur = readFileSync(dst);
			} catch {
				cur = null;
			}
			if (cur && cur.equals(want)) continue;
			drift = true;
			if (check) {
				console.error(`[sync-runtime-registry] DRIFT: ${dst} is out of sync with ${asset.name} canonical`);
			} else {
				mkdirSync(dirname(dst), { recursive: true });
				writeFileSync(dst, want);
				console.log(`[sync-runtime-registry] wrote ${dst}`);
			}
		}
		// Stale removes (vendored file no longer in canonical).
		const curRels = existsSync(target) ? listPackageFiles(target) : [];
		for (const rel of curRels) {
			if (canonSet.has(rel)) continue;
			drift = true;
			const dst = join(target, rel);
			if (check) {
				console.error(`[sync-runtime-registry] DRIFT: stale ${dst} (no longer in ${asset.name} canonical)`);
			} else {
				rmSync(dst);
				console.log(`[sync-runtime-registry] removed stale ${dst}`);
			}
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
