/**
 * Client-safe presentation helpers for the service-graph drill-down drawer:
 * categorize a span (→ icon + token color), derive a stable per-service color,
 * and format durations/cost. Keep this framework-light and DO NOT import the
 * server-only service-graph module (mirror its collapse regex instead).
 */
import {
	Sparkles,
	Wrench,
	Globe,
	Database,
	ArrowLeftRight,
	Workflow as WorkflowIcon,
	Boxes,
	Circle
} from '@lucide/svelte';

// Lucide icons are component constructors; `typeof Sparkles` is that constructor
// type (matches the nav-config pattern of `typeof GitBranch`).
type LucideIcon = typeof Sparkles;

export type SpanCategory = 'llm' | 'tool' | 'http' | 'db' | 'rpc' | 'queue' | 'workflow' | 'internal';

export interface SpanPresentation {
	category: SpanCategory;
	label: string;
	/** Lucide icon component for the category. */
	icon: LucideIcon;
	/** `text-*` token class for the icon. */
	textClass: string;
	/** `bg-*` token class for the duration bar. */
	barClass: string;
}

type SpanLike = {
	spanKind?: string;
	operationName?: string;
	attributes?: Record<string, unknown> | null;
};

const CATEGORY_STYLE: Record<SpanCategory, { label: string; icon: LucideIcon; textClass: string; barClass: string }> = {
	llm: { label: 'LLM', icon: Sparkles, textClass: 'text-chart-2', barClass: 'bg-chart-2' },
	tool: { label: 'Tool', icon: Wrench, textClass: 'text-chart-4', barClass: 'bg-chart-4' },
	http: { label: 'HTTP', icon: Globe, textClass: 'text-chart-1', barClass: 'bg-chart-1' },
	db: { label: 'DB', icon: Database, textClass: 'text-chart-3', barClass: 'bg-chart-3' },
	rpc: { label: 'RPC', icon: ArrowLeftRight, textClass: 'text-chart-5', barClass: 'bg-chart-5' },
	queue: { label: 'Queue', icon: Boxes, textClass: 'text-chart-5', barClass: 'bg-chart-5' },
	workflow: { label: 'Step', icon: WorkflowIcon, textClass: 'text-primary', barClass: 'bg-primary' },
	internal: { label: 'Internal', icon: Circle, textClass: 'text-muted-foreground', barClass: 'bg-muted-foreground' }
};

function hasPrefix(attrs: Record<string, unknown>, prefix: string): boolean {
	for (const k in attrs) if (k.startsWith(prefix)) return true;
	return false;
}

export function categorizeSpan(span: SpanLike): SpanCategory {
	const a = span.attributes ?? {};
	if ('gen_ai.tool.name' in a) return 'tool';
	if (hasPrefix(a, 'gen_ai.')) return 'llm';
	if ('db.system.name' in a || 'db.system' in a) return 'db';
	if ('http.method' in a || 'http.request.method' in a || 'url.full' in a || 'http.url' in a)
		return 'http';
	if ('rpc.system' in a) return 'rpc';
	if (hasPrefix(a, 'messaging.')) return 'queue';
	if ('workflow.node.id' in a || hasPrefix(a, 'workflow.node.')) return 'workflow';
	return 'internal';
}

export function presentSpan(span: SpanLike): SpanPresentation {
	const category = categorizeSpan(span);
	return { category, ...CATEGORY_STYLE[category] };
}

/** Mirrors the server `collapseServiceName` (per-session agent pods → one node). */
export function collapseServiceNameClient(name: string): string {
	return name.replace(/^agent-session-[0-9a-f]{8,}$/i, 'agent-session');
}

/** Stable string → one of the 5 chart palette slots (consistent service chips). */
export function serviceColor(name: string): { dotClass: string; textClass: string } {
	let hash = 0;
	const s = collapseServiceNameClient(name);
	for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
	const slot = (Math.abs(hash) % 5) + 1;
	return { dotClass: `bg-chart-${slot}`, textClass: `text-chart-${slot}` };
}

/** Pull the human-readable HTTP/RPC request summary from span attributes. */
export function httpSummary(attrs: Record<string, unknown> | null | undefined): {
	method: string | null;
	path: string | null;
	status: number | null;
} {
	const a = attrs ?? {};
	const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
	const num = (v: unknown) => {
		const n = typeof v === 'number' ? v : Number(v);
		return Number.isFinite(n) && n > 0 ? n : null;
	};
	const method = str(a['http.request.method']) ?? str(a['http.method']) ?? str(a['rpc.method']);
	const path =
		str(a['http.route']) ??
		str(a['url.path']) ??
		str(a['http.target']) ??
		str(a['url.full']) ??
		str(a['http.url']) ??
		str(a['rpc.service']);
	const status = num(a['http.response.status_code']) ?? num(a['http.status_code']);
	return { method, path, status };
}

/** HTTP status → token tone class. */
export function statusTone(status: number | null): string {
	if (status == null) return 'text-muted-foreground';
	if (status >= 500) return 'text-destructive';
	if (status >= 400) return 'text-chart-5';
	if (status >= 200 && status < 300) return 'text-chart-2';
	return 'text-muted-foreground';
}

export function fmtMs(ms: number | null | undefined): string {
	const v = Number(ms ?? 0);
	if (!Number.isFinite(v) || v <= 0) return '0ms';
	if (v >= 60_000) return `${(v / 60_000).toFixed(1)}m`;
	if (v >= 1_000) return `${(v / 1_000).toFixed(2)}s`;
	return `${Math.round(v)}ms`;
}

export function fmtCost(n: number | null | undefined): string {
	if (n == null) return '—';
	if (n > 0 && n < 0.01) return '<$0.01';
	return `$${n.toFixed(2)}`;
}

export { fmtTokens } from './format-tokens';
