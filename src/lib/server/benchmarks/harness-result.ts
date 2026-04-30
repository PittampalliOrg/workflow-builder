// Pure, defensive parser for the SWE-bench harness JSON we persist into
// `benchmark_run_instances.harness_result`. The harness JSON shape varies by
// version of `swebench.harness.run_evaluation` and by the wrapper our
// swebench-evaluator uses, so every accessor walks defensively.
//
// Common shapes observed:
//   { resolved: true|false, report: {...}, tests_status: { FAIL_TO_PASS: { success: [...], failure: [...] }, PASS_TO_PASS: {...} }, ... }
//   { status: "timeout"|"error"|"empty_patch", message: "...", source: "...", ... }
//   null  (when the harness never ran)

export type FailureCategory =
	| 'resolved'
	| 'unresolved'
	| 'empty_patch'
	| 'patch_apply_failed'
	| 'test_timeout'
	| 'test_failed'
	| 'error'
	| 'timeout'
	| 'unknown';

export type ParsedHarnessResult = {
	resolved: boolean | null;
	patchApplied: boolean | null;
	emptyPatch: boolean;
	failureCategory: FailureCategory;
	failToPass: { success: string[]; failure: string[] };
	passToPass: { success: string[]; failure: string[] };
	durationMs: number | null;
	rawMessage: string | null;
};

function asObj(v: unknown): Record<string, unknown> | null {
	return v && typeof v === 'object' && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: null;
}

function asStrArray(v: unknown): string[] {
	return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

function asNumber(v: unknown): number | null {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
	return null;
}

function readBool(v: unknown): boolean | null {
	if (v === true || v === false) return v;
	if (v === 'true' || v === 'True' || v === 1) return true;
	if (v === 'false' || v === 'False' || v === 0) return false;
	return null;
}

function readTestsBucket(o: unknown): { success: string[]; failure: string[] } {
	const obj = asObj(o);
	if (!obj) return { success: [], failure: [] };
	return {
		success: asStrArray(obj.success),
		failure: asStrArray(obj.failure)
	};
}

export function parseHarnessResult(raw: unknown): ParsedHarnessResult {
	const obj = asObj(raw);
	if (!obj) {
		return {
			resolved: null,
			patchApplied: null,
			emptyPatch: false,
			failureCategory: 'unknown',
			failToPass: { success: [], failure: [] },
			passToPass: { success: [], failure: [] },
			durationMs: null,
			rawMessage: null
		};
	}

	// Some payloads put the actual harness result in a `harness_result` /
	// `report` sub-object; unwrap if so.
	const inner = asObj(obj.harness_result) ?? asObj(obj.harnessResult) ?? obj;

	const resolved = readBool(inner.resolved);
	const report = asObj(inner.report);
	const patchApplied =
		readBool(report?.patch_successfully_applied) ??
		readBool(inner.patch_successfully_applied) ??
		(report?.patch_exists != null ? readBool(report.patch_exists) : null);
	const emptyPatch =
		readBool(report?.patch_is_None) === true ||
		readBool(inner.patch_is_None) === true ||
		(typeof obj.status === 'string' && obj.status === 'empty_patch') ||
		(typeof inner.status === 'string' && inner.status === 'empty_patch');

	const tests = asObj(inner.tests_status);
	const failToPass = readTestsBucket(tests?.FAIL_TO_PASS ?? tests?.fail_to_pass);
	const passToPass = readTestsBucket(tests?.PASS_TO_PASS ?? tests?.pass_to_pass);

	const rawMessage =
		typeof obj.message === 'string'
			? obj.message
			: typeof inner.message === 'string'
				? (inner.message as string)
				: null;

	const durationMs =
		asNumber(inner.duration_ms) ??
		asNumber(inner.durationMs) ??
		asNumber(obj.duration_ms) ??
		asNumber(obj.durationMs);

	const category = categorize({
		topStatus: typeof obj.status === 'string' ? obj.status : null,
		innerStatus: typeof inner.status === 'string' ? inner.status : null,
		resolved,
		emptyPatch,
		patchApplied,
		failToPassFailures: failToPass.failure.length,
		passToPassFailures: passToPass.failure.length,
		message: rawMessage
	});

	return {
		resolved,
		patchApplied,
		emptyPatch,
		failureCategory: category,
		failToPass,
		passToPass,
		durationMs,
		rawMessage
	};
}

function categorize(input: {
	topStatus: string | null;
	innerStatus: string | null;
	resolved: boolean | null;
	emptyPatch: boolean;
	patchApplied: boolean | null;
	failToPassFailures: number;
	passToPassFailures: number;
	message: string | null;
}): FailureCategory {
	if (input.resolved === true) return 'resolved';
	if (input.topStatus === 'timeout' || input.innerStatus === 'timeout') return 'timeout';
	if (input.topStatus === 'error' || input.innerStatus === 'error') return 'error';
	if (input.emptyPatch || input.topStatus === 'empty_patch') return 'empty_patch';
	if (input.patchApplied === false) return 'patch_apply_failed';
	if (input.message?.toLowerCase().includes('timeout')) return 'test_timeout';
	if (input.failToPassFailures > 0 || input.passToPassFailures > 0) return 'test_failed';
	if (input.resolved === false) return 'unresolved';
	return 'unknown';
}

export function aggregateFailureCategories(
	results: Array<ParsedHarnessResult | null | undefined>
): Record<FailureCategory, number> {
	const counts: Record<FailureCategory, number> = {
		resolved: 0,
		unresolved: 0,
		empty_patch: 0,
		patch_apply_failed: 0,
		test_timeout: 0,
		test_failed: 0,
		error: 0,
		timeout: 0,
		unknown: 0
	};
	for (const r of results) {
		if (!r) continue;
		counts[r.failureCategory] = (counts[r.failureCategory] ?? 0) + 1;
	}
	return counts;
}
