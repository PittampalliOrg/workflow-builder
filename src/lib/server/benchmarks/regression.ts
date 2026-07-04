// Statistical regression detection between two benchmark runs.
//
// Two test families:
//   1. Fisher's exact test for binary outcomes (resolved-rate). Exact p-value
//      from the hypergeometric distribution; reliable at small N where chi²
//      breaks down (and SWE-bench runs often have N=3..50 instances).
//   2. Welch's t-test for continuous metrics (turn_count, tokens, ttft, cost).
//      Unequal-variance two-sample test — appropriate when the two runs may
//      have different spreads. We approximate the t-distribution CDF via
//      the regularized incomplete beta function (Lentz's continued fraction).
//
// All math is pure-TS — no scipy / jstat / simple-statistics dep. The only
// non-obvious piece is the incomplete-beta routine; tested against known
// values in regression.test.ts. Run-id persistence lives in the application
// adapter layer; this module only compares already-loaded metrics.

export type RegressionMetric =
	| "resolved_rate"
	| "cost_per_resolved"
	| "turn_count_p50"
	| "tokens_p50"
	| "ttft_p50"
	| "tool_call_count_p50";

export type RegressionTestKind = "fisher_exact" | "welch_t";

export type RegressionTest = {
	metric: RegressionMetric;
	kind: RegressionTestKind;
	baseline: { mean: number; n: number; ci95: [number, number] | null };
	candidate: { mean: number; n: number; ci95: [number, number] | null };
	delta: number;
	pValue: number;
	significant: boolean; // pValue < 0.05
	direction: "better" | "worse" | "neutral";
};

/* -------------------------------------------------------------------------- */
/*                                  Fisher                                    */
/* -------------------------------------------------------------------------- */

// Two-tailed Fisher's exact test on a 2×2 contingency table:
//
//                  pass        fail
//   baseline   |    a    |     b      | a+b
//   candidate  |    c    |     d      | c+d
//                  a+c        b+d
//
// p = sum over all tables with the same marginals whose probability is ≤ the
// observed table's probability. We enumerate by varying `a` from max(0, n1-n0+a0+c0-...)
// to min(n1, a+c) and sum the hypergeometric pmf.
export function fisherExact(a: number, b: number, c: number, d: number): number {
	const n = a + b + c + d;
	const r1 = a + b;
	const r2 = c + d;
	const c1 = a + c;
	if (r1 === 0 || r2 === 0 || c1 === 0 || c1 === n) return 1;
	const observed = hypergeomPmf(a, r1, c1, n);
	const aMin = Math.max(0, c1 - r2);
	const aMax = Math.min(r1, c1);
	let pSum = 0;
	const eps = 1e-12;
	for (let k = aMin; k <= aMax; k++) {
		const p = hypergeomPmf(k, r1, c1, n);
		if (p <= observed + eps) pSum += p;
	}
	return Math.min(1, pSum);
}

function hypergeomPmf(k: number, r1: number, c1: number, n: number): number {
	return Math.exp(
		logBinom(c1, k) + logBinom(n - c1, r1 - k) - logBinom(n, r1),
	);
}

function logBinom(n: number, k: number): number {
	if (k < 0 || k > n) return -Infinity;
	return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

// Lanczos approximation for log-gamma. Accurate to ~15 digits for x > 0.5.
function logGamma(x: number): number {
	if (x < 0.5) {
		return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
	}
	const g = 7;
	const c = [
		0.99999999999980993, 676.5203681218851, -1259.1392167224028,
		771.32342877765313, -176.61502916214059, 12.507343278686905,
		-0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
	];
	x -= 1;
	let y = c[0];
	for (let i = 1; i < g + 2; i++) y += c[i] / (x + i);
	const t = x + g + 0.5;
	return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(y);
}

/* -------------------------------------------------------------------------- */
/*                               Welch's t-test                               */
/* -------------------------------------------------------------------------- */

export function welchTTest(a: number[], b: number[]): { t: number; df: number; pValue: number } {
	if (a.length < 2 || b.length < 2) return { t: 0, df: 0, pValue: 1 };
	const ma = mean(a);
	const mb = mean(b);
	const va = variance(a, ma);
	const vb = variance(b, mb);
	const seSq = va / a.length + vb / b.length;
	const se = Math.sqrt(seSq);
	if (se === 0) return { t: 0, df: 0, pValue: 1 };
	const t = (ma - mb) / se;
	const df =
		(seSq * seSq) /
		((va * va) / (a.length * a.length * (a.length - 1)) +
			(vb * vb) / (b.length * b.length * (b.length - 1)));
	const pValue = 2 * (1 - studentTCdf(Math.abs(t), df));
	return { t, df, pValue: Math.max(0, Math.min(1, pValue)) };
}

function mean(xs: number[]): number {
	let s = 0;
	for (const x of xs) s += x;
	return s / xs.length;
}

function variance(xs: number[], m: number): number {
	if (xs.length < 2) return 0;
	let s = 0;
	for (const x of xs) {
		const d = x - m;
		s += d * d;
	}
	return s / (xs.length - 1);
}

// Student's t CDF via the regularized incomplete beta function:
//   F(t; ν) = 1 - 0.5 * I(ν/(ν+t²); ν/2, 1/2)   for t ≥ 0
function studentTCdf(t: number, df: number): number {
	if (df <= 0) return 0.5;
	const x = df / (df + t * t);
	const ib = regIncompleteBeta(x, df / 2, 0.5);
	return 1 - 0.5 * ib;
}

// Regularized incomplete beta I_x(a, b) via Lentz's continued fraction
// (Numerical Recipes §6.4). Accurate enough for p-value display purposes.
function regIncompleteBeta(x: number, a: number, b: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	const lbeta = logGamma(a + b) - logGamma(a) - logGamma(b);
	const front = Math.exp(lbeta + a * Math.log(x) + b * Math.log(1 - x));
	if (x < (a + 1) / (a + b + 2)) {
		return (front * betacf(x, a, b)) / a;
	}
	return 1 - (front * betacf(1 - x, b, a)) / b;
}

function betacf(x: number, a: number, b: number): number {
	const MAX_IT = 200;
	const EPS = 3e-7;
	const FPMIN = 1e-30;
	const qab = a + b;
	const qap = a + 1;
	const qam = a - 1;
	let c = 1;
	let d = 1 - (qab * x) / qap;
	if (Math.abs(d) < FPMIN) d = FPMIN;
	d = 1 / d;
	let h = d;
	for (let m = 1; m <= MAX_IT; m++) {
		const m2 = 2 * m;
		let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
		d = 1 + aa * d;
		if (Math.abs(d) < FPMIN) d = FPMIN;
		c = 1 + aa / c;
		if (Math.abs(c) < FPMIN) c = FPMIN;
		d = 1 / d;
		h *= d * c;
		aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
		d = 1 + aa * d;
		if (Math.abs(d) < FPMIN) d = FPMIN;
		c = 1 + aa / c;
		if (Math.abs(c) < FPMIN) c = FPMIN;
		d = 1 / d;
		const del = d * c;
		h *= del;
		if (Math.abs(del - 1) < EPS) return h;
	}
	return h;
}

/* -------------------------------------------------------------------------- */
/*                          Confidence intervals                               */
/* -------------------------------------------------------------------------- */

// 95% CI for a sample mean via the normal approximation. Adequate for n >= 5.
// For very small n we'd use the t-distribution but those CIs would be too
// wide to be useful anyway; a null-CI signal is more honest.
function ci95Mean(xs: number[]): [number, number] | null {
	if (xs.length < 5) return null;
	const m = mean(xs);
	const sd = Math.sqrt(variance(xs, m));
	const se = sd / Math.sqrt(xs.length);
	return [m - 1.96 * se, m + 1.96 * se];
}

// 95% Wilson score interval for a binomial proportion. Better than the
// normal approximation at small n / extreme p.
function ci95Proportion(successes: number, total: number): [number, number] | null {
	if (total === 0) return null;
	const p = successes / total;
	const z = 1.96;
	const z2 = z * z;
	const denom = 1 + z2 / total;
	const center = (p + z2 / (2 * total)) / denom;
	const radius =
		(z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
	return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

/* -------------------------------------------------------------------------- */
/*                                 Helpers                                    */
/* -------------------------------------------------------------------------- */

function percentile(sorted: number[], p: number): number | null {
	if (sorted.length === 0) return null;
	const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
	return sorted[idx];
}

export type RunInstanceMetrics = {
	resolved: boolean;
	turnCount: number | null;
	toolCallCount: number | null;
	tokens: number | null;
	ttft: number | null;
	costUsd: number | null;
};

/* -------------------------------------------------------------------------- */
/*                              Public entrypoint                              */
/* -------------------------------------------------------------------------- */

/**
 * Compare two benchmark run metric sets across the canonical metrics. Treats
 * `baseline` as the established run and `candidate` as the new variant. Direction
 * heuristic: lower is better for {cost_per_resolved, turn_count, ttft, tokens,
 * tool_call_count}; higher is better for {resolved_rate}. Significance is
 * pValue < 0.05.
 */
export function compareRunMetrics(
	baseline: RunInstanceMetrics[],
	candidate: RunInstanceMetrics[],
): RegressionTest[] {
	const tests: RegressionTest[] = [];

	// resolved_rate — Fisher's exact (binary outcome)
	{
		const aPass = baseline.filter((x) => x.resolved).length;
		const aFail = baseline.length - aPass;
		const cPass = candidate.filter((x) => x.resolved).length;
		const cFail = candidate.length - cPass;
		const baselineMean = baseline.length ? aPass / baseline.length : 0;
		const candidateMean = candidate.length ? cPass / candidate.length : 0;
		const pValue = fisherExact(aPass, aFail, cPass, cFail);
		const delta = candidateMean - baselineMean;
		tests.push({
			metric: "resolved_rate",
			kind: "fisher_exact",
			baseline: {
				mean: baselineMean,
				n: baseline.length,
				ci95: ci95Proportion(aPass, baseline.length),
			},
			candidate: {
				mean: candidateMean,
				n: candidate.length,
				ci95: ci95Proportion(cPass, candidate.length),
			},
			delta,
			pValue,
			significant: pValue < 0.05,
			direction: directionFor("resolved_rate", delta, pValue),
		});
	}

	// Continuous metrics — Welch's t-test on per-instance values.
	const continuous: Array<{
		metric: RegressionMetric;
		extract: (m: RunInstanceMetrics) => number | null;
	}> = [
		{ metric: "cost_per_resolved", extract: (m) => (m.resolved && m.costUsd ? m.costUsd : null) },
		{ metric: "turn_count_p50", extract: (m) => m.turnCount },
		{ metric: "tokens_p50", extract: (m) => m.tokens },
		{ metric: "ttft_p50", extract: (m) => m.ttft },
		{ metric: "tool_call_count_p50", extract: (m) => m.toolCallCount },
	];

	for (const { metric, extract } of continuous) {
		const aVals = baseline.map(extract).filter((v): v is number => v !== null && Number.isFinite(v));
		const cVals = candidate.map(extract).filter((v): v is number => v !== null && Number.isFinite(v));
		const aSorted = [...aVals].sort((x, y) => x - y);
		const cSorted = [...cVals].sort((x, y) => x - y);
		const baselineMean = aVals.length ? mean(aVals) : 0;
		const candidateMean = cVals.length ? mean(cVals) : 0;
		const baselineP50 = percentile(aSorted, 0.5) ?? 0;
		const candidateP50 = percentile(cSorted, 0.5) ?? 0;
		const { pValue } = welchTTest(aVals, cVals);
		// Use median (P50) for *_p50 metric labels — that's what the UI shows.
		const showMedian = metric.endsWith("_p50");
		const baselineDisplay = showMedian ? baselineP50 : baselineMean;
		const candidateDisplay = showMedian ? candidateP50 : candidateMean;
		const delta = candidateDisplay - baselineDisplay;
		tests.push({
			metric,
			kind: "welch_t",
			baseline: { mean: baselineDisplay, n: aVals.length, ci95: ci95Mean(aVals) },
			candidate: { mean: candidateDisplay, n: cVals.length, ci95: ci95Mean(cVals) },
			delta,
			pValue,
			significant: pValue < 0.05,
			direction: directionFor(metric, delta, pValue),
		});
	}

	return tests;
}

function directionFor(metric: RegressionMetric, delta: number, pValue: number): "better" | "worse" | "neutral" {
	if (pValue >= 0.05) return "neutral";
	const lowerIsBetter: ReadonlyArray<RegressionMetric> = [
		"cost_per_resolved",
		"turn_count_p50",
		"tokens_p50",
		"ttft_p50",
		"tool_call_count_p50",
	];
	const isLowerBetter = lowerIsBetter.includes(metric);
	if (delta === 0) return "neutral";
	if (isLowerBetter) return delta < 0 ? "better" : "worse";
	return delta > 0 ? "better" : "worse";
}
