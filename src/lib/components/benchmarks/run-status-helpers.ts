// Pure helpers shared by the benchmarks UI (instances browser, runs index,
// run detail, compare grid). Extracted from the legacy +page.svelte so all
// surfaces render the same colors / labels.

export function statusColor(status: string | null | undefined): string {
	const s = (status ?? '').toLowerCase();
	switch (s) {
		case 'completed':
		case 'resolved':
		case 'validated':
		case 'inferred':
		case 'success':
		case 'passed':
			return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400';
		case 'inferencing':
		case 'evaluating':
		case 'building':
		case 'running':
			return 'bg-blue-500/15 text-blue-700 dark:text-blue-400';
		case 'queued':
		case 'pending':
		case 'fallback':
		case 'not_built':
			return 'bg-amber-500/15 text-amber-700 dark:text-amber-400';
		case 'unresolved':
		case 'empty_patch':
		case 'failed':
		case 'error':
		case 'timeout':
			return 'bg-red-500/15 text-red-700 dark:text-red-400';
		case 'cancelled':
			return 'bg-gray-400/15 text-gray-600 dark:text-gray-400';
		default:
			return 'bg-muted text-muted-foreground';
	}
}

export function formatStatus(status: string | null | undefined): string {
	return (status || 'pending').replaceAll('_', ' ');
}

export function formatBuildStrategy(strategy: string | null | undefined): string {
	if (strategy === 'swebench-harness') return 'SWE-bench harness spec';
	if (strategy === 'buildpacks') return 'Buildpacks fallback';
	return formatStatus(strategy);
}

export function formatRelative(iso: string | null | undefined): string {
	if (!iso) return 'never';
	const diff = Date.now() - new Date(iso).getTime();
	if (Number.isNaN(diff)) return iso;
	if (diff < 60_000) return 'just now';
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return new Date(iso).toLocaleDateString();
}

export function formatDuration(ms: number | null | undefined): string {
	if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
	if (ms < 1000) return `${ms}ms`;
	const sec = ms / 1000;
	if (sec < 60) return `${sec.toFixed(1)}s`;
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	if (m < 60) return `${m}m ${s}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m`;
}

export function formatTokens(n: number | null | undefined): string {
	if (n == null || !Number.isFinite(n)) return '—';
	if (n < 1_000) return String(n);
	if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatPercent(p: number | null | undefined, digits = 0): string {
	if (p == null || !Number.isFinite(p)) return '—';
	return `${(p * 100).toFixed(digits)}%`;
}

export function formatCostUsd(usd: number | null | undefined): string {
	if (usd == null || !Number.isFinite(usd)) return '—';
	if (usd < 0.01) return `< $0.01`;
	if (usd < 10) return `$${usd.toFixed(2)}`;
	return `$${usd.toFixed(0)}`;
}

export type RunStatusToken =
	| 'queued'
	| 'inferencing'
	| 'evaluating'
	| 'completed'
	| 'failed'
	| 'cancelled';

export function isActiveRunStatus(status: string | null | undefined): boolean {
	return status === 'queued' || status === 'inferencing' || status === 'evaluating';
}

export function suiteShortLabel(slug: string): string {
	if (slug === 'SWE-bench_Verified') return 'Verified';
	if (slug === 'SWE-bench_Lite') return 'Lite';
	if (slug === 'SWE-bench') return 'Full';
	return slug;
}
