import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;

type SuiteSlug = "SWE-bench_Lite" | "SWE-bench_Verified";

type SuiteDefinition = {
	id: string;
	slug: SuiteSlug;
	name: string;
	description: string;
	datasetName: string;
	datasetSplit: "test";
	sourceUrl: string;
	defaultInstanceLimit: number;
	metadata: Record<string, unknown>;
};

type Args = {
	suite: SuiteSlug | "all";
	source: string | null;
	revision: string | null;
	limit: number | null;
	pageSize: number;
	dryRun: boolean;
	preserveExisting: boolean;
};

type NormalizedInstance = {
	instanceId: string;
	repo: string | null;
	baseCommit: string | null;
	problemStatement: string | null;
	hintsText: string | null;
	testMetadata: Record<string, unknown>;
	goldPatch: string | null;
	metadata: Record<string, unknown>;
};

type Sql = ReturnType<typeof postgres>;

const SUITES: SuiteDefinition[] = [
	{
		id: "bsuite_swebench_verified",
		slug: "SWE-bench_Verified",
		name: "SWE-bench Verified",
		description: "Human-validated SWE-bench subset for software issue resolution.",
		datasetName: "princeton-nlp/SWE-bench_Verified",
		datasetSplit: "test",
		sourceUrl: "https://www.swebench.com/",
		defaultInstanceLimit: 500,
		metadata: { family: "swebench", official: true },
	},
	{
		id: "bsuite_swebench_lite",
		slug: "SWE-bench_Lite",
		name: "SWE-bench Lite",
		description: "Smaller SWE-bench subset commonly used for faster evaluation.",
		datasetName: "princeton-nlp/SWE-bench_Lite",
		datasetSplit: "test",
		sourceUrl: "https://www.swebench.com/",
		defaultInstanceLimit: 300,
		metadata: { family: "swebench", official: true },
	},
];

function parseArgs(argv: string[]): Args {
	const args: Args = {
		suite: "all",
		source: null,
		revision: null,
		limit: null,
		pageSize: 100,
		dryRun: false,
		preserveExisting: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--suite") {
			args.suite = normalizeSuiteArg(requiredArg(argv, ++i, "--suite"));
		} else if (arg === "--source") {
			args.source = requiredArg(argv, ++i, "--source");
		} else if (arg === "--revision") {
			args.revision = requiredArg(argv, ++i, "--revision");
		} else if (arg === "--limit") {
			args.limit = positiveInteger(requiredArg(argv, ++i, "--limit"), "--limit");
		} else if (arg === "--page-size") {
			args.pageSize = positiveInteger(requiredArg(argv, ++i, "--page-size"), "--page-size");
		} else if (arg === "--dry-run") {
			args.dryRun = true;
		} else if (arg === "--apply") {
			args.dryRun = false;
		} else if (arg === "--preserve-existing") {
			args.preserveExisting = true;
		} else if (arg === "--help" || arg === "-h") {
			printUsage();
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return args;
}

function printUsage() {
	console.log(
		[
			"Usage:",
			"  DATABASE_URL=... pnpm tsx scripts/import-swebench-benchmark-instances.ts --suite all",
			"  DATABASE_URL=... pnpm tsx scripts/import-swebench-benchmark-instances.ts --suite lite --source swebench_lite.jsonl",
			"",
			"Options:",
			"  --suite all|lite|verified|SWE-bench_Lite|SWE-bench_Verified",
			"  --source PATH    Read rows from local JSON/JSONL instead of datasets-server.",
			"  --revision REV   Store source revision/provenance in metadata.",
			"  --limit N        Import at most N rows per suite.",
			"  --page-size N    Hugging Face rows page size. Default: 100.",
			"  --dry-run        Fetch and validate rows without writing.",
			"  --preserve-existing  Do not delete existing suite rows absent from the import.",
		].join("\n"),
	);
}

function normalizeSuiteArg(value: string): Args["suite"] {
	const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
	if (normalized === "all") return "all";
	if (
		normalized === "lite" ||
		normalized === "swe_bench_lite" ||
		normalized === "swebench_lite"
	) {
		return "SWE-bench_Lite";
	}
	if (
		normalized === "verified" ||
		normalized === "swe_bench_verified" ||
		normalized === "swebench_verified"
	) {
		return "SWE-bench_Verified";
	}
	throw new Error(`Unsupported --suite value: ${value}`);
}

function requiredArg(argv: string[], index: number, flag: string): string {
	const value = argv[index];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function positiveInteger(value: string, flag: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${flag} must be a positive integer`);
	}
	return parsed;
}

async function loadRowsForSuite(
	suite: SuiteDefinition,
	args: Args,
): Promise<Record<string, unknown>[]> {
	const rows = args.source
		? await readRowsFromFile(args.source)
		: await fetchRowsFromDatasetsServer(suite, args.pageSize);
	return args.limit ? rows.slice(0, args.limit) : rows;
}

async function readRowsFromFile(path: string): Promise<Record<string, unknown>[]> {
	const text = await readFile(path, "utf8");
	if (path.endsWith(".jsonl")) {
		return text
			.split(/\r?\n/g)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => expectRecord(JSON.parse(line)));
	}
	const payload = JSON.parse(text) as unknown;
	if (Array.isArray(payload)) return payload.map(expectRecord);
	if (isRecord(payload) && Array.isArray(payload.rows)) {
		return payload.rows.map((row) =>
			isRecord(row) && isRecord(row.row) ? row.row : expectRecord(row),
		);
	}
	throw new Error(`Unsupported JSON shape in ${path}`);
}

async function fetchRowsFromDatasetsServer(
	suite: SuiteDefinition,
	pageSize: number,
): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	let offset = 0;
	let total: number | null = null;
	while (total === null || offset < total) {
		const payload = await fetchDatasetsPage(suite, offset, pageSize);
		const rows = Array.isArray(payload.rows) ? payload.rows : [];
		for (const item of rows) {
			if (isRecord(item) && isRecord(item.row)) out.push(item.row);
			else out.push(expectRecord(item));
		}
		total = typeof payload.num_rows_total === "number" ? payload.num_rows_total : out.length;
		if (rows.length === 0) break;
		offset += rows.length;
	}
	return out;
}

async function fetchDatasetsPage(
	suite: SuiteDefinition,
	offset: number,
	length: number,
): Promise<Record<string, unknown>> {
	const base = new URL("https://datasets-server.huggingface.co/rows");
	base.searchParams.set("dataset", suite.datasetName);
	base.searchParams.set("split", suite.datasetSplit);
	base.searchParams.set("offset", String(offset));
	base.searchParams.set("length", String(length));
	const urls = [base.toString()];
	base.searchParams.set("config", "default");
	urls.push(base.toString());
	let lastError = "";
	for (const url of urls) {
		const response = await fetch(url);
		if (response.ok) return expectRecord(await response.json());
		lastError = `${response.status} ${await response.text()}`;
	}
	throw new Error(`Failed to fetch ${suite.datasetName} rows: ${lastError.slice(0, 500)}`);
}

function normalizeInstance(
	raw: Record<string, unknown>,
	suite: SuiteDefinition,
	args: Args,
	importedAt: string,
): NormalizedInstance {
	const instanceId = readRequiredString(raw, "instance_id");
	const testMetadata: Record<string, unknown> = {};
	for (const key of [
		"test_patch",
		"FAIL_TO_PASS",
		"PASS_TO_PASS",
		"fail_to_pass",
		"pass_to_pass",
		"version",
		"environment_setup_commit",
	]) {
		if (raw[key] !== undefined) testMetadata[key] = raw[key];
	}
	return {
		instanceId,
		repo: readOptionalString(raw, "repo") ?? repoFromInstanceId(instanceId),
		baseCommit: readOptionalString(raw, "base_commit"),
		problemStatement: readOptionalString(raw, "problem_statement"),
		hintsText: readOptionalString(raw, "hints_text") ?? readOptionalString(raw, "hints"),
		testMetadata,
		goldPatch: readOptionalString(raw, "patch"),
		metadata: {
			...raw,
			workflowBuilderImport: {
				importStatus: "imported",
				datasetName: suite.datasetName,
				datasetSplit: suite.datasetSplit,
				revision: args.revision,
				importedAt,
				source: args.source ? "local-file" : "datasets-server",
			},
		},
	};
}

async function upsertSuite(sql: Sql, suite: SuiteDefinition) {
	await sql`
		insert into benchmark_suites (
			id, slug, name, description, dataset_name, dataset_split,
			source_url, default_instance_limit, metadata, updated_at
		)
		values (
			${suite.id}, ${suite.slug}, ${suite.name}, ${suite.description},
			${suite.datasetName}, ${suite.datasetSplit}, ${suite.sourceUrl},
			${suite.defaultInstanceLimit}, ${sql.json(suite.metadata)}, now()
		)
		on conflict (slug) do update set
			name = excluded.name,
			description = excluded.description,
			dataset_name = excluded.dataset_name,
			dataset_split = excluded.dataset_split,
			source_url = excluded.source_url,
			default_instance_limit = excluded.default_instance_limit,
			metadata = excluded.metadata,
			updated_at = now()
	`;
}

async function upsertInstance(
	sql: Sql,
	suite: SuiteDefinition,
	instance: NormalizedInstance,
) {
	await sql`
		insert into benchmark_instances (
			id, suite_id, instance_id, repo, base_commit, problem_statement,
			hints_text, test_metadata, gold_patch, metadata, updated_at
		)
		values (
			${`binst_${randomUUID().replace(/-/g, "")}`},
			${suite.id},
			${instance.instanceId},
			${instance.repo},
			${instance.baseCommit},
			${instance.problemStatement},
			${instance.hintsText},
			${sql.json(instance.testMetadata)},
			${instance.goldPatch},
			${sql.json(instance.metadata)},
			now()
		)
		on conflict (suite_id, instance_id) do update set
			repo = excluded.repo,
			base_commit = excluded.base_commit,
			problem_statement = excluded.problem_statement,
			hints_text = excluded.hints_text,
			test_metadata = excluded.test_metadata,
			gold_patch = excluded.gold_patch,
			metadata = excluded.metadata,
			updated_at = now()
	`;
}

async function deleteStaleSuiteInstances(
	sql: Sql,
	suite: SuiteDefinition,
	instanceIds: string[],
): Promise<number> {
	const rows = await sql<{ id: string }[]>`
		delete from benchmark_instances
		where suite_id = ${suite.id}
			and instance_id != all(${instanceIds})
		returning id
	`;
	return rows.length;
}

function selectedSuites(args: Args): SuiteDefinition[] {
	return args.suite === "all"
		? SUITES
		: SUITES.filter((suite) => suite.slug === args.suite);
}

function readRequiredString(raw: Record<string, unknown>, key: string): string {
	const value = readOptionalString(raw, key);
	if (!value) throw new Error(`SWE-bench row is missing ${key}`);
	return value;
}

function readOptionalString(raw: Record<string, unknown>, key: string): string | null {
	const value = raw[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function repoFromInstanceId(instanceId: string): string | null {
	const match = /^([^_]+)__([^-]+)-/.exec(instanceId);
	if (!match) return null;
	return `${match[1]}/${match[2]}`;
}

function expectRecord(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error("Expected an object row");
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const importedAt = new Date().toISOString();
	const suites = selectedSuites(args);
	const sql =
		args.dryRun || !DATABASE_URL
			? null
			: postgres(DATABASE_URL, { max: 1, prepare: false });
	if (!args.dryRun && !DATABASE_URL) {
		throw new Error("DATABASE_URL is required unless --dry-run is set");
	}
	try {
		for (const suite of suites) {
			const rows = await loadRowsForSuite(suite, args);
			const normalized = rows.map((row) => normalizeInstance(row, suite, args, importedAt));
			const incomplete = normalized.filter(
				(row) => !row.repo || !row.baseCommit || !row.problemStatement,
			);
			console.log(
				JSON.stringify({
					suite: suite.slug,
					mode: args.dryRun ? "dry-run" : "apply",
					rows: normalized.length,
					incomplete: incomplete.length,
					cutover: !args.preserveExisting,
				}),
			);
			if (!sql) continue;
			await upsertSuite(sql, suite);
			for (const instance of normalized) {
				await upsertInstance(sql, suite, instance);
			}
			if (!args.preserveExisting) {
				const deleted = await deleteStaleSuiteInstances(
					sql,
					suite,
					normalized.map((row) => row.instanceId),
				);
				console.log(JSON.stringify({ suite: suite.slug, deletedStaleRows: deleted }));
			}
		}
	} finally {
		if (sql) await sql.end({ timeout: 5 });
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
