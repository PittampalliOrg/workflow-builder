/**
 * Span-kind design system — the single source of truth for how an agent
 * trace is colored, iconned, and labelled across the whole observability UI
 * (waterfall, list, detail drawer, turns view).
 *
 * Visual direction: "vivid AI-native" — span KIND drives color everywhere.
 * We key primarily off OpenInference `openinference.span.kind` (we emit it),
 * with name-based heuristics as a fallback for infra spans (http/db/workflow).
 * Red is reserved exclusively for errors (applied at render time, not here).
 */
import {
	Sparkles,
	Wrench,
	Workflow,
	Bot,
	Database,
	Search,
	Layers3,
	Gauge,
	ShieldCheck,
	Network,
	Box
} from '@lucide/svelte';
import type { Component } from 'svelte';
import type { ObservabilityTraceSpan } from '$lib/types/observability';

/** A lucide-svelte icon component (size/class props). */
export type IconComponent = Component<{ size?: number | string; class?: string }>;

export type SpanKind =
	| 'llm'
	| 'tool'
	| 'chain'
	| 'agent'
	| 'retriever'
	| 'reranker'
	| 'embedding'
	| 'evaluator'
	| 'guardrail'
	| 'workflow'
	| 'http'
	| 'db'
	| 'span';

export interface SpanKindStyle {
	key: SpanKind;
	label: string;
	icon: IconComponent;
	/** Foreground text color class (the kind's accent). */
	text: string;
	/** Subtle tinted surface for badges/cards. */
	bg: string;
	/** Border class matching the accent. */
	border: string;
	/** Waterfall duration-bar background (gradient). */
	bar: string;
	/** Solid accent for dots / left-rails. */
	dot: string;
	/** Raw hex for inline styles, canvas, and the color-by-kind legend. */
	hex: string;
}

/**
 * Vivid AI-native palette tuned for a near-black (#0b0c0e) base. Colors are the
 * Tailwind -400 family (bright enough to pop on black without vibrating).
 */
export const SPAN_KIND_STYLE: Record<SpanKind, SpanKindStyle> = {
	llm: {
		key: 'llm',
		label: 'LLM',
		icon: Sparkles,
		text: 'text-cyan-300',
		bg: 'bg-cyan-500/10',
		border: 'border-cyan-500/25',
		bar: 'bg-gradient-to-r from-cyan-500 to-cyan-300',
		dot: 'bg-cyan-400',
		hex: '#22d3ee'
	},
	tool: {
		key: 'tool',
		label: 'TOOL',
		icon: Wrench,
		text: 'text-emerald-300',
		bg: 'bg-emerald-500/10',
		border: 'border-emerald-500/25',
		bar: 'bg-gradient-to-r from-emerald-500 to-emerald-300',
		dot: 'bg-emerald-400',
		hex: '#34d399'
	},
	chain: {
		key: 'chain',
		label: 'CHAIN',
		icon: Layers3,
		text: 'text-violet-300',
		bg: 'bg-violet-500/10',
		border: 'border-violet-500/25',
		bar: 'bg-gradient-to-r from-violet-500 to-violet-300',
		dot: 'bg-violet-400',
		hex: '#a78bfa'
	},
	agent: {
		key: 'agent',
		label: 'AGENT',
		icon: Bot,
		text: 'text-amber-300',
		bg: 'bg-amber-500/10',
		border: 'border-amber-500/25',
		bar: 'bg-gradient-to-r from-amber-500 to-amber-300',
		dot: 'bg-amber-400',
		hex: '#fbbf24'
	},
	retriever: {
		key: 'retriever',
		label: 'RETRIEVER',
		icon: Search,
		text: 'text-sky-300',
		bg: 'bg-sky-500/10',
		border: 'border-sky-500/25',
		bar: 'bg-gradient-to-r from-sky-500 to-sky-300',
		dot: 'bg-sky-400',
		hex: '#38bdf8'
	},
	reranker: {
		key: 'reranker',
		label: 'RERANKER',
		icon: Gauge,
		text: 'text-teal-300',
		bg: 'bg-teal-500/10',
		border: 'border-teal-500/25',
		bar: 'bg-gradient-to-r from-teal-500 to-teal-300',
		dot: 'bg-teal-400',
		hex: '#2dd4bf'
	},
	embedding: {
		key: 'embedding',
		label: 'EMBEDDING',
		icon: Network,
		text: 'text-indigo-300',
		bg: 'bg-indigo-500/10',
		border: 'border-indigo-500/25',
		bar: 'bg-gradient-to-r from-indigo-500 to-indigo-300',
		dot: 'bg-indigo-400',
		hex: '#818cf8'
	},
	evaluator: {
		key: 'evaluator',
		label: 'EVAL',
		icon: ShieldCheck,
		text: 'text-pink-300',
		bg: 'bg-pink-500/10',
		border: 'border-pink-500/25',
		bar: 'bg-gradient-to-r from-pink-500 to-pink-300',
		dot: 'bg-pink-400',
		hex: '#f472b6'
	},
	guardrail: {
		key: 'guardrail',
		label: 'GUARDRAIL',
		icon: ShieldCheck,
		text: 'text-rose-300',
		bg: 'bg-rose-500/10',
		border: 'border-rose-500/25',
		bar: 'bg-gradient-to-r from-rose-500 to-rose-300',
		dot: 'bg-rose-400',
		hex: '#fb7185'
	},
	workflow: {
		key: 'workflow',
		label: 'WORKFLOW',
		icon: Workflow,
		text: 'text-fuchsia-300',
		bg: 'bg-fuchsia-500/10',
		border: 'border-fuchsia-500/25',
		bar: 'bg-gradient-to-r from-fuchsia-500 to-fuchsia-300',
		dot: 'bg-fuchsia-400',
		hex: '#e879f9'
	},
	http: {
		key: 'http',
		label: 'HTTP',
		icon: Network,
		text: 'text-slate-300',
		bg: 'bg-slate-500/10',
		border: 'border-slate-500/25',
		bar: 'bg-gradient-to-r from-slate-500 to-slate-300',
		dot: 'bg-slate-400',
		hex: '#94a3b8'
	},
	db: {
		key: 'db',
		label: 'DB',
		icon: Database,
		text: 'text-blue-300',
		bg: 'bg-blue-500/10',
		border: 'border-blue-500/25',
		bar: 'bg-gradient-to-r from-blue-500 to-blue-300',
		dot: 'bg-blue-400',
		hex: '#60a5fa'
	},
	span: {
		key: 'span',
		label: 'SPAN',
		icon: Box,
		text: 'text-zinc-300',
		bg: 'bg-white/5',
		border: 'border-white/15',
		bar: 'bg-gradient-to-r from-zinc-500 to-zinc-400',
		dot: 'bg-zinc-400',
		hex: '#a1a1aa'
	}
};

/** Error accent — applied at render time when a span/turn failed. */
export const ERROR_STYLE = {
	text: 'text-red-300',
	bg: 'bg-red-500/10',
	border: 'border-red-500/30',
	bar: 'bg-gradient-to-r from-red-500 to-red-400',
	dot: 'bg-red-400',
	hex: '#f87171'
};

const OI_KIND_MAP: Record<string, SpanKind> = {
	LLM: 'llm',
	TOOL: 'tool',
	CHAIN: 'chain',
	AGENT: 'agent',
	RETRIEVER: 'retriever',
	RERANKER: 'reranker',
	EMBEDDING: 'embedding',
	EVALUATOR: 'evaluator',
	GUARDRAIL: 'guardrail'
};

function attrString(attrs: Record<string, unknown> | undefined, key: string): string | null {
	if (!attrs) return null;
	const v = attrs[key];
	return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Resolve a span's kind. Priority: OpenInference attribute → name heuristics.
 * Heuristics cover the infra spans our Dapr workflow emits (http/db/workflow)
 * that don't carry an `openinference.span.kind`.
 */
export function resolveSpanKind(
	span: Pick<ObservabilityTraceSpan, 'operationName' | 'attributes' | 'spanKind'>
): SpanKind {
	const oi = attrString(span.attributes, 'openinference.span.kind');
	if (oi && OI_KIND_MAP[oi.toUpperCase()]) return OI_KIND_MAP[oi.toUpperCase()];

	const name = (span.operationName ?? '').toLowerCase();
	if (/call_llm|llm_request|\bllm\b|chat\.completions|generate/.test(name)) return 'llm';
	if (/run_tool|execute_tool|tool_call|\btool\b/.test(name)) return 'tool';
	if (/update_goal|create_goal|get_goal|@wfb|mcp/.test(name)) return 'tool';
	if (/evaluat|verify|acceptance/.test(name)) return 'evaluator';
	if (/embedding/.test(name)) return 'embedding';
	if (/retriev|search/.test(name)) return 'retriever';
	if (/workflowactivity|sw-workflows|child_workflow|session_workflow|spawn_session|durable/.test(name))
		return 'workflow';
	if (/activity\|\||\bactivity\b|orchestrat|\.run$|step/.test(name)) return 'chain';
	if (/getstate|setstate|state\.|load_with_etag|\bredis\b|postgres|\bsql\b|\bdb\b/.test(name))
		return 'db';
	if (/^(get|post|put|patch|delete)\b|http|sveltekit|\/api\/|taskhub|\.dapr\./.test(name))
		return 'http';
	return 'span';
}

export function spanKindStyle(
	span: Pick<ObservabilityTraceSpan, 'operationName' | 'attributes' | 'spanKind'>
): SpanKindStyle {
	return SPAN_KIND_STYLE[resolveSpanKind(span)];
}

/** Deterministic, stable color per service name (for color-by-service mode). */
const SERVICE_HEX = [
	'#22d3ee',
	'#34d399',
	'#a78bfa',
	'#fbbf24',
	'#38bdf8',
	'#f472b6',
	'#2dd4bf',
	'#818cf8',
	'#e879f9',
	'#fb923c',
	'#4ade80',
	'#60a5fa'
];
export function serviceColor(name: string): string {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return SERVICE_HEX[h % SERVICE_HEX.length];
}

// --- Shared formatters (used across list, waterfall, detail, header) ---

export function formatDuration(ms: number | null | undefined): string {
	if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
	if (ms < 1) return '<1ms';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
	const m = Math.floor(ms / 60000);
	const s = Math.round((ms % 60000) / 1000);
	return `${m}m ${s}s`;
}

export function formatTokens(n: number | null | undefined): string {
	if (!n || n <= 0) return '';
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCost(usd: number | null | undefined): string {
	if (usd == null || !Number.isFinite(usd) || usd <= 0) return '';
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	if (usd < 1) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(2)}`;
}

export function relativeTime(iso: string): string {
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return '';
	const s = Math.max(0, (Date.now() - t) / 1000);
	if (s < 60) return `${Math.floor(s)}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}
