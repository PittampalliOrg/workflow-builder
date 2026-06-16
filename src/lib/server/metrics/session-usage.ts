/**
 * Per-session ACTUAL resource consumption — sampling + right-sizing.
 *
 * Kueue admits sandbox pods on their REQUESTS (a static guess), but we never
 * measured what a session actually uses, so requests are hand-tuned. This
 * accumulates real metrics-server samples per session (under `usage.resource`,
 * no schema change) so we can recommend right-sized requests.
 *
 * See docs/session-resource-metrics-and-kueue-admission.md.
 */

import { and, gte, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import { agents, sessions } from "$lib/server/db/schema";
import { eq } from "drizzle-orm";
import { getResourceUsage } from "./resources";

export type SessionResourceUsage = {
	peakCpuMillicores: number;
	peakMemoryMiB: number;
	cpuMillicoreSum: number; // ÷ sampleCount → average
	memoryMiBSum: number;
	sampleCount: number;
	sampledAt: string;
};

/** Statuses whose pod may be live + worth sampling. */
const SAMPLEABLE_STATUSES = ["running", "idle", "rescheduling", "active", "starting"];

function podNameForSession(row: {
	runtimeSandboxName: string | null;
	runtimeAppId: string | null;
}): string | null {
	if (row.runtimeSandboxName?.trim()) return row.runtimeSandboxName.trim();
	if (row.runtimeAppId?.trim()) return `agent-host-${row.runtimeAppId.trim()}`;
	return null;
}

/**
 * One sampling tick: read live per-pod usage, attribute it to the owning
 * session by pod name, and merge peak/sum/count into `sessions.usage.resource`.
 * Idempotent-ish (peak is monotonic; sum/count accrue once per tick). Driven by
 * the `session-resource-sample` CronJob. Returns counts for observability.
 */
export async function sampleAndPersistSessionResourceUsage(): Promise<{
	pods: number;
	matched: number;
}> {
	if (!db) throw new Error("Database not configured");
	const live = await getResourceUsage();
	const byPod = new Map(live.pods.map((p) => [p.name, p]));

	const rows = await db
		.select({
			id: sessions.id,
			usage: sessions.usage,
			runtimeSandboxName: sessions.runtimeSandboxName,
			runtimeAppId: sessions.runtimeAppId,
		})
		.from(sessions)
		.where(inArray(sessions.status, SAMPLEABLE_STATUSES));

	const sampledAt = new Date().toISOString();
	let matched = 0;
	for (const row of rows) {
		const podName = podNameForSession(row);
		if (!podName) continue;
		const pod = byPod.get(podName);
		if (!pod) continue; // no live pod / no sample yet
		matched += 1;
		const usage = (row.usage ?? {}) as Record<string, unknown>;
		const prev = (usage.resource ?? {}) as Partial<SessionResourceUsage>;
		const merged: SessionResourceUsage = {
			peakCpuMillicores: Math.max(prev.peakCpuMillicores ?? 0, pod.cpuMillicores),
			peakMemoryMiB: Math.max(prev.peakMemoryMiB ?? 0, pod.memoryMiB),
			cpuMillicoreSum: (prev.cpuMillicoreSum ?? 0) + pod.cpuMillicores,
			memoryMiBSum: (prev.memoryMiBSum ?? 0) + pod.memoryMiB,
			sampleCount: (prev.sampleCount ?? 0) + 1,
			sampledAt,
		};
		await db
			.update(sessions)
			.set({ usage: { ...usage, resource: merged } })
			.where(eq(sessions.id, row.id));
	}
	return { pods: live.pods.length, matched };
}

export type RuntimeRightsizing = {
	runtime: string;
	sampledSessions: number;
	avgPeakCpuMillicores: number;
	p90PeakCpuMillicores: number;
	maxPeakCpuMillicores: number;
	avgPeakMemoryMiB: number;
	p90PeakMemoryMiB: number;
	maxPeakMemoryMiB: number;
	/** Recommended request = P90 peak + ~20% headroom, rounded to a sane step. */
	recommendedCpuRequestMillicores: number;
	recommendedMemoryRequestMiB: number;
};

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx];
}
const roundUp = (n: number, step: number) => Math.max(step, Math.ceil(n / step) * step);

/**
 * Aggregate persisted per-session peaks by agent runtime → recommended requests
 * (P90 peak + 20% headroom). Read-only advisory; the operator still edits the
 * SANDBOX_EXECUTION_CLASSES_JSON render heredoc to apply.
 */
export async function computeRightsizingRecommendations(
	windowDays = 14,
): Promise<RuntimeRightsizing[]> {
	if (!db) throw new Error("Database not configured");
	const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
	const rows = await db
		.select({ usage: sessions.usage, runtime: agents.runtime })
		.from(sessions)
		.innerJoin(agents, eq(agents.id, sessions.agentId))
		.where(and(gte(sessions.createdAt, since)));

	const byRuntime = new Map<string, { cpu: number[]; mem: number[] }>();
	for (const row of rows) {
		const res = ((row.usage ?? {}) as Record<string, unknown>).resource as
			| Partial<SessionResourceUsage>
			| undefined;
		const runtime = row.runtime ?? "unknown";
		if (!res || !res.sampleCount) continue;
		const bucket = byRuntime.get(runtime) ?? { cpu: [], mem: [] };
		bucket.cpu.push(res.peakCpuMillicores ?? 0);
		bucket.mem.push(res.peakMemoryMiB ?? 0);
		byRuntime.set(runtime, bucket);
	}

	const out: RuntimeRightsizing[] = [];
	for (const [runtime, b] of byRuntime) {
		const cpu = [...b.cpu].sort((x, y) => x - y);
		const mem = [...b.mem].sort((x, y) => x - y);
		const avg = (a: number[]) => Math.round(a.reduce((s, n) => s + n, 0) / a.length);
		const p90Cpu = percentile(cpu, 90);
		const p90Mem = percentile(mem, 90);
		out.push({
			runtime,
			sampledSessions: cpu.length,
			avgPeakCpuMillicores: avg(cpu),
			p90PeakCpuMillicores: p90Cpu,
			maxPeakCpuMillicores: cpu[cpu.length - 1] ?? 0,
			avgPeakMemoryMiB: avg(mem),
			p90PeakMemoryMiB: p90Mem,
			maxPeakMemoryMiB: mem[mem.length - 1] ?? 0,
			recommendedCpuRequestMillicores: roundUp(Math.round(p90Cpu * 1.2), 50),
			recommendedMemoryRequestMiB: roundUp(Math.round(p90Mem * 1.2), 128),
		});
	}
	return out.sort((a, b) => b.sampledSessions - a.sampledSessions);
}
