#!/usr/bin/env node
/**
 * gen-catalog-snapshot — CI tool that produces a CODE-FREE catalog snapshot of
 * AVAILABLE-only Activepieces pieces (the ~hundreds in the AP catalog that are
 * NOT bundled into this image's piece-registry.ts).
 *
 * For each target piece it ephemerally `npm install`s the package in an isolated
 * temp dir, imports it, and runs the bundle-free `buildPieceCatalogRow` against
 * it — producing REAL our-format metadata (displayName, logoUrl, categories,
 * action/trigger summaries, version, digest) without adding the piece to the
 * bundle. The committed snapshot is then seeded as `available_only=true`
 * piece_metadata rows by sync-metadata (offline at deploy time — no runtime
 * dependency on the AP cloud API).
 *
 * INVARIANT: this never makes a piece runnable. enabled-and-runnable ⊆ bundled.
 * Available-only rows are display/discovery affordances; enabling one still
 * requires the bundle + image rebuild (the "Adding piece" flow).
 *
 * Runs in CI (needs npm + network), NOT in the production image. Invoke with
 * `pnpm gen:catalog-snapshot` (tsx). See docs/activepieces-catalog-expansion.md.
 *
 * Usage:
 *   tsx src/gen-catalog-snapshot.ts --discover [--out src/piece-catalog-snapshot.json]
 *   tsx src/gen-catalog-snapshot.ts --packages-file pieces.txt
 *   tsx src/gen-catalog-snapshot.ts --piece slack --piece stripe --limit 5
 *
 * Flags:
 *   --discover               fetch the full piece list + versions from the AP cloud API
 *   --packages-file <path>   newline-delimited piece specs (@activepieces/piece-x[@ver] | bare slug)
 *   --piece <slug|pkg>       explicit target (repeatable)
 *   --exclude-bundled        drop pieces already in this package's bundle (default: on)
 *   --include-bundled        keep bundled pieces too (off by default)
 *   --limit <n>              cap the number of targets (testing)
 *   --concurrency <n>        parallel isolated installs (default 6)
 *   --out <path>             snapshot output (default src/piece-catalog-snapshot.json)
 *   --discover-url <url>     override the AP cloud pieces endpoint
 *   --dry-run                resolve + print the target list, do not install
 */
import { execFile } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

// Async exec so the worker pool ACTUALLY parallelizes — execFileSync blocks the
// single Node thread, serializing every install regardless of pool size.
const execFileAsync = promisify(execFile);
import type {
	CatalogSnapshot,
	SlimOperation,
	SnapshotPiece,
} from "./catalog-snapshot-types.js";
import { buildPieceCatalogRow, type PieceCatalogRow } from "./metadata-row.js";
import { normalizePieceName } from "./piece-name.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Local tsx bin — each piece is built in a FRESH child process so its imported
// module tree is reclaimed on exit (Node's ESM loader never unloads modules; a
// single-process run leaks ~80MB/piece and OOMs by ~piece 150 at this scale).
const TSX_BIN = resolve(__dirname, "..", "node_modules", ".bin", "tsx");
const DEFAULT_DISCOVER_URL = "https://cloud.activepieces.com/api/v1/pieces";
const SNAPSHOT_SCHEMA_VERSION = 1;

type Target = { pkg: string; version: string | null };
type Failure = { pkg: string; error: string };

/** Project a full PieceCatalogRow → the slim, code-free available-only shape. */
function slimRow(row: PieceCatalogRow, sourcePackage: string): SnapshotPiece {
	const slimOps = (
		ops: Record<string, { name: string; displayName: string; description: string | null; requireAuth: boolean }>,
	): Record<string, SlimOperation> =>
		Object.fromEntries(
			Object.entries(ops).map(([k, op]) => [
				k,
				{
					name: op.name,
					displayName: op.displayName,
					description: op.description,
					requireAuth: op.requireAuth,
				},
			]),
		);
	const authType =
		row.auth && typeof row.auth === "object"
			? ((row.auth as { type?: unknown }).type ?? null)
			: null;
	return {
		name: row.name,
		authors: row.authors,
		displayName: row.displayName,
		logoUrl: row.logoUrl,
		description: row.description,
		version: row.version,
		minimumSupportedRelease: row.minimumSupportedRelease,
		maximumSupportedRelease: row.maximumSupportedRelease,
		authType: typeof authType === "string" ? authType : null,
		categories: row.categories,
		pieceType: row.pieceType,
		packageType: row.packageType,
		catalogSchemaVersion: row.catalogSchemaVersion,
		catalogDigest: row.catalogDigest,
		actions: slimOps(row.actions),
		triggers: slimOps(
			row.triggers as Record<
				string,
				{ name: string; displayName: string; description: string | null; requireAuth: boolean }
			>,
		),
		sourcePackage,
	};
}

type CliOptions = {
	discover: boolean;
	discoverUrl: string;
	packagesFile: string | null;
	pieces: string[];
	excludeBundled: boolean;
	limit: number | null;
	concurrency: number;
	out: string;
	dryRun: boolean;
	// child-mode (internal): build ONE piece, write the envelope to resultFile, exit
	buildOne: string | null;
	buildVersion: string | null;
	resultFile: string | null;
};

function parseArgs(argv: string[]): CliOptions {
	const o: CliOptions = {
		discover: false,
		discoverUrl: DEFAULT_DISCOVER_URL,
		packagesFile: null,
		pieces: [],
		excludeBundled: true,
		limit: null,
		concurrency: 6,
		out: resolve(__dirname, "piece-catalog-snapshot.json"),
		dryRun: false,
		buildOne: null,
		buildVersion: null,
		resultFile: null,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = () => argv[++i];
		if (arg === "--discover") o.discover = true;
		else if (arg === "--discover-url") o.discoverUrl = next() ?? o.discoverUrl;
		else if (arg === "--packages-file") o.packagesFile = next() ?? null;
		else if (arg === "--piece") o.pieces.push(next() ?? "");
		else if (arg.startsWith("--piece=")) o.pieces.push(arg.slice("--piece=".length));
		else if (arg === "--exclude-bundled") o.excludeBundled = true;
		else if (arg === "--include-bundled") o.excludeBundled = false;
		else if (arg === "--limit") o.limit = Number(next());
		else if (arg === "--concurrency") o.concurrency = Math.max(1, Number(next()) || 6);
		else if (arg === "--out") o.out = resolve(next() ?? o.out);
		else if (arg === "--dry-run") o.dryRun = true;
		else if (arg === "--build-one") o.buildOne = next() ?? null;
		else if (arg === "--build-version") o.buildVersion = next() ?? null;
		else if (arg === "--result-file") o.resultFile = next() ?? null;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	o.pieces = o.pieces.map((p) => p.trim()).filter(Boolean);
	return o;
}

type ChildEnvelope =
	| { ok: true; piece: SnapshotPiece }
	| { ok: false; error: string };

/** Normalize any spec (bare slug | @activepieces/piece-x | …@version) to a Target. */
function toTarget(spec: string): Target | null {
	const trimmed = spec.trim();
	if (!trimmed || trimmed.startsWith("#")) return null;
	// split a trailing @version that is NOT the leading scope @
	const at = trimmed.lastIndexOf("@");
	let name = trimmed;
	let version: string | null = null;
	if (at > 0) {
		name = trimmed.slice(0, at);
		version = trimmed.slice(at + 1) || null;
	}
	const slug = normalizePieceName(name);
	if (!slug) return null;
	return { pkg: `@activepieces/piece-${slug}`, version };
}

/** The pieces bundled into THIS image (the runnable set) — read from package.json deps. */
function bundledSlugs(): Set<string> {
	const pkgJson = JSON.parse(
		readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
	) as { dependencies?: Record<string, string> };
	const slugs = new Set<string>();
	for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
		const m = dep.match(/^@activepieces\/piece-(.+)$/);
		if (m) slugs.add(m[1]);
	}
	return slugs;
}

type ApPieceSummary = { name?: unknown; version?: unknown };

async function discoverTargets(url: string): Promise<Target[]> {
	const res = await fetch(url, { headers: { accept: "application/json" } });
	if (!res.ok) throw new Error(`discover failed: ${res.status} ${res.statusText}`);
	const body = (await res.json()) as ApPieceSummary[];
	const targets: Target[] = [];
	for (const summary of body) {
		const name = typeof summary.name === "string" ? summary.name : null;
		if (!name || !name.startsWith("@activepieces/piece-")) continue;
		const version = typeof summary.version === "string" ? summary.version : null;
		targets.push({ pkg: name, version });
	}
	return targets;
}

// biome-ignore lint/suspicious/noExplicitAny: piece module shape is dynamic
function findPiece(mod: Record<string, any>): any | null {
	// A createPiece() Piece is uniquely identified by a CALLABLE `.actions`
	// accessor. Individual Action exports (which many pieces also export at the
	// top level) carry `.displayName`/`.props` but NO `.actions` function — so a
	// looser "has displayName" heuristic would pick the wrong object and yield
	// zero actions. Require the piece signature; prefer one that also has the
	// `.triggers` accessor.
	const candidates = [...Object.values(mod), mod.default].filter(Boolean);
	const isPiece = (v: unknown): boolean =>
		!!v && typeof v === "object" && typeof (v as { actions?: unknown }).actions === "function";
	return (
		candidates.find(
			(v) => isPiece(v) && typeof (v as { triggers?: unknown }).triggers === "function",
		) ??
		candidates.find(isPiece) ??
		null
	);
}

/** Isolated-install one piece + build its catalog row. Throws on any failure. */
async function snapshotPiece(target: Target): Promise<SnapshotPiece> {
	const tmp = mkdtempSync(join(tmpdir(), "ap-catalog-"));
	try {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify(
				{
					name: "ap-catalog-probe",
					private: true,
					// Recent @activepieces/pieces-common pins axios@1.15.2, which is not
					// published (latest is 1.15.0) → ERR_PNPM_NO_MATCHING_VERSION on the
					// newest pieces (the AI providers especially). Force a real axios; it
					// only affects execution-time HTTP, not the metadata we extract here.
					pnpm: { overrides: { axios: "1.15.0" } },
				},
				null,
				2,
			),
		);
		const spec = target.version ? `${target.pkg}@${target.version}` : target.pkg;
		// pnpm's content-addressable store is parallel-safe and hardlinks shared
		// deps (most AP pieces share pieces-framework/common) — ~8× faster than npm
		// here and no cache-lock serialization across concurrent workers.
		// --ignore-scripts: published pieces are precompiled JS, no build step.
		await execFileAsync("pnpm", ["add", "--ignore-scripts", "--prefer-offline", spec], {
			cwd: tmp,
			timeout: 180_000,
		});
		const req = createRequire(join(tmp, "package.json"));
		const entry = req.resolve(target.pkg);
		const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
		const piece = findPiece(mod as Record<string, never>);
		if (!piece) {
			throw new Error(
				`no Piece export (keys=${Object.keys(mod).join(",") || "none"})`,
			);
		}
		// The on-disk packageVersion scan can't see the temp install, so read the
		// installed package.json version and inject it (keeps version + digest
		// consistent for the piece's own `version` fallback chain).
		let installedVersion: string | null = target.version;
		try {
			installedVersion =
				(JSON.parse(readFileSync(req.resolve(`${target.pkg}/package.json`), "utf8")) as {
					version?: string;
				}).version ?? target.version;
		} catch {
			// keep the requested version (or null)
		}
		const slug = normalizePieceName(target.pkg);
		// extensionsFor intentionally omitted: available-only pieces carry no
		// bespoke in-repo extensions (those exist only for bundled pieces).
		const row = buildPieceCatalogRow({ pieceName: slug, piece, version: installedVersion });
		return slimRow(row, target.pkg);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/**
 * Build ONE piece in a fresh child process and read its result back from a temp
 * file. The file handoff (vs stdout) is robust against pieces that console.log
 * on import — that noise can't corrupt the envelope. The child's whole module
 * tree is reclaimed by the OS when it exits, so memory stays bounded regardless
 * of catalog size.
 */
async function buildOneInChild(target: Target): Promise<SnapshotPiece> {
	const resultFile = join(tmpdir(), `ap-catalog-result-${randomChildId()}.json`);
	try {
		const args = [
			__filename,
			"--build-one",
			target.pkg,
			"--result-file",
			resultFile,
		];
		if (target.version) args.push("--build-version", target.version);
		await execFileAsync(TSX_BIN, args, {
			// Run the child in tmpdir so a piece's import-time file logger (e.g.
			// scrapeless' winston) writes there, not into the repo working tree.
			cwd: tmpdir(),
			timeout: 200_000,
			// pnpm/import stderr noise is captured (not inherited); we only read the file
			maxBuffer: 64 * 1024 * 1024,
		});
		const envelope = JSON.parse(readFileSync(resultFile, "utf8")) as ChildEnvelope;
		if (!envelope.ok) throw new Error(envelope.error);
		return envelope.piece;
	} finally {
		rmSync(resultFile, { force: true });
	}
}

let childIdCounter = 0;
function randomChildId(): string {
	childIdCounter += 1;
	return `${process.pid}-${childIdCounter}`;
}

async function runPool<T, R>(
	items: T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	async function drain(): Promise<void> {
		while (cursor < items.length) {
			const i = cursor++;
			results[i] = await worker(items[i], i);
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, () => drain()),
	);
	return results;
}

async function resolveTargets(o: CliOptions): Promise<Target[]> {
	const specs: string[] = [...o.pieces];
	if (o.packagesFile) {
		specs.push(...readFileSync(o.packagesFile, "utf8").split(/\r?\n/));
	}
	let targets = specs.map(toTarget).filter((t): t is Target => t !== null);
	if (o.discover) {
		targets = targets.concat(await discoverTargets(o.discoverUrl));
	}
	// de-dup by package, preferring an explicit version when present
	const byPkg = new Map<string, Target>();
	for (const t of targets) {
		const existing = byPkg.get(t.pkg);
		if (!existing || (!existing.version && t.version)) byPkg.set(t.pkg, t);
	}
	let deduped = [...byPkg.values()];
	if (o.excludeBundled) {
		const bundled = bundledSlugs();
		deduped = deduped.filter((t) => !bundled.has(normalizePieceName(t.pkg)));
	}
	deduped.sort((a, b) => a.pkg.localeCompare(b.pkg));
	if (o.limit != null) deduped = deduped.slice(0, o.limit);
	return deduped;
}

/** Child mode: build one piece, write the envelope to the result file, exit 0. */
async function runChild(o: CliOptions): Promise<void> {
	const target: Target = { pkg: o.buildOne as string, version: o.buildVersion };
	let envelope: ChildEnvelope;
	try {
		envelope = { ok: true, piece: await snapshotPiece(target) };
	} catch (error) {
		const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
		envelope = { ok: false, error: message };
	}
	if (!o.resultFile) throw new Error("--build-one requires --result-file");
	writeFileSync(o.resultFile, JSON.stringify(envelope));
}

async function main(): Promise<void> {
	const o = parseArgs(process.argv.slice(2));
	if (o.buildOne) {
		await runChild(o);
		return;
	}
	const targets = await resolveTargets(o);
	console.log(
		`[gen-catalog-snapshot] ${targets.length} target piece(s) (excludeBundled=${o.excludeBundled}, concurrency=${o.concurrency})`,
	);
	if (o.dryRun) {
		for (const t of targets) {
			console.log(`  ${t.pkg}${t.version ? `@${t.version}` : ""}`);
		}
		return;
	}

	let done = 0;
	const failures: Failure[] = [];
	const settled = await runPool(targets, o.concurrency, async (t) => {
		try {
			const piece = await buildOneInChild(t);
			done += 1;
			console.log(
				`  [${done}/${targets.length}] ${piece.name}@${piece.version} actions=${Object.keys(piece.actions).length} triggers=${Object.keys(piece.triggers).length}`,
			);
			return piece;
		} catch (error) {
			const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
			failures.push({ pkg: t.pkg, error: message });
			console.warn(`  [skip] ${t.pkg}: ${message}`);
			return null;
		}
	});

	const built = settled.filter((p): p is SnapshotPiece => p !== null);
	// Drop AP platform primitives: pieces tagged CORE with NO auth are flow-control
	// / utility built-ins (delay, schedule, webhook, store, http, csv, approval,
	// manual-trigger) that duplicate our native node types and have no external
	// service to connect. CORE pieces that DO carry auth (sftp, smtp) are real
	// connectable integrations and are kept.
	const isCorePrimitive = (p: SnapshotPiece) =>
		p.categories.includes("CORE") && !p.authType;
	const excludedCore = built.filter(isCorePrimitive).map((p) => p.name).sort();
	const pieces = built
		.filter((p) => !isCorePrimitive(p))
		.sort((a, b) => a.name.localeCompare(b.name));
	if (excludedCore.length) {
		console.log(
			`[gen-catalog-snapshot] excluded ${excludedCore.length} CORE-primitive piece(s): ${excludedCore.join(", ")}`,
		);
	}

	const snapshot: CatalogSnapshot = {
		snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
		catalogSchemaVersion: pieces[0]?.catalogSchemaVersion ?? 1,
		generatedAt: new Date().toISOString(),
		generator: "gen-catalog-snapshot",
		count: pieces.length,
		failures,
		excludedCore,
		pieces,
	};
	writeFileSync(o.out, `${JSON.stringify(snapshot, null, 2)}\n`);
	console.log(
		`[gen-catalog-snapshot] wrote ${pieces.length} piece(s) (${failures.length} failed) → ${o.out}`,
	);
	if (failures.length) {
		console.log(
			`[gen-catalog-snapshot] failures: ${failures.map((f) => f.pkg).join(", ")}`,
		);
	}
}

main().catch((error) => {
	console.error("[gen-catalog-snapshot] failed:", error);
	process.exit(1);
});
