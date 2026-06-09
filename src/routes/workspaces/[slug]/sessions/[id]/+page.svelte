<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, onMount } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import {
		Card,
		CardContent,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Switch } from '$lib/components/ui/switch';
	import { Label } from '$lib/components/ui/label';
	import {
		Popover,
		PopoverContent,
		PopoverTrigger
	} from '$lib/components/ui/popover';
	import ApiSnippet from '$lib/components/console/api-snippet.svelte';
	import CopyIdButton from '$lib/components/console/copy-id-button.svelte';
	import RegistryStatusBadge from '$lib/components/agents/registry-status-badge.svelte';
	import AgentModelSelector from '$lib/components/agents/agent-model-selector.svelte';
	import EventRow from '$lib/components/sessions/event-row.svelte';
	import EventDetailPanel from '$lib/components/sessions/event-detail-panel.svelte';
	import { findToolPair, computeTokenAssignments } from '$lib/utils/tool-pair';
	import BatchDetailPanel from '$lib/components/sessions/batch-detail-panel.svelte';
	import SessionTimelineBar from '$lib/components/sessions/session-timeline-bar.svelte';
	import EventTypePill from '$lib/components/sessions/event-type-pill.svelte';
	import StopReasonChip from '$lib/components/sessions/stop-reason-chip.svelte';
	import SessionResourcesPanel from '$lib/components/sessions/session-resources-panel.svelte';
	import SessionOutputsPanel from '$lib/components/sessions/session-outputs-panel.svelte';
	import SessionCapacityCard from '$lib/components/capacity/session-capacity-card.svelte';
	import BrowserStatePanel from '$lib/components/sessions/browser-state-panel.svelte';
	import PodShellPanel from '$lib/components/sessions/pod-shell-panel.svelte';
	import OpenShellTerminalTabs from '$lib/components/sessions/openshell-terminal-tabs.svelte';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch-plus';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import SessionConfigDrawer from '$lib/components/sessions/session-config-drawer.svelte';
	import type { AgentDetail } from '$lib/types/agents';
	import {
		Reasoning,
		ReasoningTrigger,
		ReasoningContent
	} from '$lib/components/ui/ai-elements/reasoning';
	import {
		Archive,
		ArrowLeft,
		Bot,
		Activity,
		Check,
		ChevronDown,
		ChevronUp,
		Cloud,
		Clock,
		Code2,
		Container,
		Download,
		ExternalLink,
		FileText,
		Filter,
		Layers,
		Loader2,
		MessagesSquare,
		MoreVertical,
		PanelRight,
		Save,
		Search,
		Send,
		Settings,
		Sparkles,
		Square,
		Terminal,
		Trash2,
		User,
		Workflow,
		Wrench,
		X
	} from '@lucide/svelte';
	import {
		createSessionStream,
		type InFlightPartial,
		type SessionStreamStore
	} from '$lib/stores/session-stream.svelte';
	import type {
		SessionDetail,
		SessionEventEnvelope
	} from '$lib/types/sessions';
	import {
		agentSummaryStore,
		ensureAgentSummaries
	} from '$lib/stores/agent-summary.svelte';

	const slug = $derived((page.params.slug as string) ?? 'default');

	const sessionId = page.params.id as string;

	let session = $state<SessionDetail | null>(null);
	let events = $state<SessionEventEnvelope[]>([]);
	let inFlightPartials = $state<Record<string, InFlightPartial>>({});
	let agentRegistry = $state<{
		status: 'unregistered' | 'registered' | 'failed' | 'archiving' | 'archived';
		syncedAt: string | null;
		error: string | null;
	} | null>(null);
	// Breadcrumb back to the workflow run that spawned this session (set
	// only when session.workflowExecutionId is present — i.e., the bridge
	// created this session for a durable/run task).
	let workflowRunContext = $state<{
		workflowId: string;
		workflowName: string;
		executionId: string;
	} | null>(null);
	const agents = agentSummaryStore();

	onMount(() => {
		void ensureAgentSummaries();
	});

	$effect(() => {
		const id = session?.agentId;
		if (!id) {
			agentRegistry = null;
			return;
		}
		fetch(`/api/agents/${id}/registry`)
			.then((r) => (r.ok ? r.json() : null))
			.then((data) => {
				agentRegistry = data
					? {
							status: data.status,
							syncedAt: data.syncedAt,
							error: data.error
						}
					: null;
			})
			.catch(() => {
				agentRegistry = null;
			});
	});

	$effect(() => {
		// Workflow context now ships on SessionDetail via a server-side join
		// in listSessions/getSession — no extra round-trips needed.
		const execId = session?.workflowExecutionId;
		const wfId = session?.workflowId;
		const wfName = session?.workflowName;
		if (!execId || !wfId) {
			workflowRunContext = null;
			return;
		}
		workflowRunContext = {
			workflowId: wfId,
			workflowName: wfName ?? wfId,
			executionId: String(execId)
		};
	});
	// Transcript: user-facing messages + tool-use (compacted); hides thinking
	// and raw status events. Debug: every event verbatim. Browser state:
	// MCP-driven snapshot + console of the agent's chromium sidecar.
	// Shell: web terminal via Kubernetes pods/exec into a chosen pod
	// container. The last two tabs are gated by runtime flags.
	let viewMode = $state<'transcript' | 'debug' | 'browser-state' | 'shell' | 'openshell-terminal'>('transcript');

	// Runtime flags (polled) that drive which extra tabs are visible.
	let runtimeFlags = $state<{
		browserSidecarEnabled: boolean;
		browserMcpAvailable: boolean;
		shellAvailable: boolean;
		shellContainers: string[];
		phase?: string;
	} | null>(null);
	let runtimeTimer: ReturnType<typeof setInterval> | null = null;
	async function refreshRuntimeFlags() {
		try {
			const res = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/runtime-flags`);
			if (!res.ok) return;
			const body = (await res.json()) as {
				browserSidecarEnabled?: boolean;
				browserMcpAvailable?: boolean;
				shellAvailable?: boolean;
				shellContainers?: string[];
				phase?: string;
			};
			runtimeFlags = {
				browserSidecarEnabled: body.browserSidecarEnabled === true,
				browserMcpAvailable: body.browserMcpAvailable === true,
				shellAvailable: body.shellAvailable === true,
				shellContainers: body.shellContainers ?? [],
				phase: body.phase,
			};
			// Fallback if a gated tab becomes unavailable mid-session.
			if (viewMode === 'browser-state' && !runtimeFlags.browserSidecarEnabled) {
				viewMode = 'transcript';
			}
			if (viewMode === 'shell' && !runtimeFlags.shellAvailable) {
				viewMode = 'transcript';
			}
			if (viewMode === 'openshell-terminal' && !session?.workspaceSandboxName && !session?.runtimeSandboxName) {
				viewMode = 'transcript';
			}
		} catch {
			/* poll again next tick */
		}
	}
	// Types that the Transcript view hides — the polished CMA-style read where
	// only User / Tool / Agent rows are visible. The full stream stays available
	// in Debug. Tool results are folded into their tool_use row's detail panel
	// via findToolPair, so they don't need their own list row. Model/usage
	// events surface their tokens inline on the message/tool row that consumed
	// them via computeTokenAssignments.
	const TRANSCRIPT_HIDDEN_TYPES: ReadonlySet<string> = new Set([
		'agent.thinking',
		'agent.thinking_delta',
		'agent.message_delta',
		'agent.tool_input_delta',
		'agent.tool_result',
		'agent.mcp_tool_result',
		'agent.custom_tool_result',
		'agent.context_usage',
		'agent.llm_usage',
		'agent.iteration',
		'agent.thread_context_compacted',
		'agent.thread_images_compacted',
		'span.model_request_start',
		'span.model_request_end',
		'session.status_running',
		'session.status_idle',
		'session.status_rescheduled',
		'session.runtime_config',
		'session.turn_started',
		'session.instructions_applied',
		'session.config_updated',
		'instance.metrics_summary',
		'llm_start',
		'llm_complete'
	]);

	const displayEvents = $derived.by(() => {
		let list = events;
		if (viewMode !== 'debug') {
			list = list.filter((e) => {
				if (TRANSCRIPT_HIDDEN_TYPES.has(e.type)) return false;
				return true;
			});
		}
		if (visibleKinds.size > 0) {
			list = list.filter((e) => visibleKinds.has(e.type));
		}
		if (searchText.trim()) {
			const q = searchText.trim().toLowerCase();
			list = list.filter((e) => {
				if (e.type.toLowerCase().includes(q)) return true;
				const d = e.data as Record<string, unknown>;
				const content = (d.content as Array<{ text?: string }>) ?? [];
				const text = content
					.map((c) => (typeof c?.text === 'string' ? c.text : ''))
					.join(' ')
					.toLowerCase();
				return text.includes(q);
			});
		}
		return list;
	});

	// Token cost per row, attributing each agent.llm_usage event to the
	// content event that consumed it. Computed once per `events` change.
	const tokenAssignments = $derived(computeTokenAssignments(events));
	// Collapse consecutive same-tool rows into one — CMA shows "Web Search × 5"
	// for a batch of 5 `agent.tool_use` events with the same tool name. We
	// keep the full list in `displayEvents` for JSON export + debug view, but
	// the left list uses this compacted shape in Transcript mode.
	type BatchedEvent = {
		event: SessionEventEnvelope;
		children: SessionEventEnvelope[];
		count: number;
	};
	type SessionMlflowGroup = {
		experimentId: string | null;
		mlflowSessionId: string | null;
		sessionUrl: string | null;
		runUrl: string | null;
		traceSearchUrl: string | null;
		links: Array<{
			mlflowEntityType?: string | null;
			mlflowRunId?: string | null;
			mlflowPublicUrl?: string | null;
			source?: string | null;
		}>;
	};
	type RuntimeConfigSource = 'memory' | 'state' | 'event' | 'settings';
	type RuntimeConfigData = {
		source?: RuntimeConfigSource;
		sessionId?: string;
		instanceId?: string;
		turn?: number;
		configRevision?: number;
		configHash?: string;
		agent?: Record<string, unknown>;
		llm?: Record<string, unknown>;
		execution?: Record<string, unknown>;
		tools?: Record<string, unknown>;
		mcp?: Record<string, unknown>;
		skills?: unknown[];
		instructions?: Record<string, unknown>;
		mlflow?: Record<string, unknown>;
		dapr?: Record<string, unknown>;
		attributes?: Record<string, unknown>;
	};
	type RuntimeConfigCloudEvent = {
		specversion: '1.0';
		id: string;
		source: string;
		type: 'io.workflow-builder.session.runtime_config.v1';
		subject: string;
		datacontenttype: 'application/json';
		dataschema?: string;
		traceparent?: string;
		data: RuntimeConfigData;
	};
	const batchedEvents = $derived.by<BatchedEvent[]>(() => {
		if (viewMode === 'debug') {
			return displayEvents.map((event) => ({ event, children: [event], count: 1 }));
		}
		const out: BatchedEvent[] = [];
		for (const e of displayEvents) {
			const isTool =
				e.type === 'agent.tool_use' ||
				e.type === 'agent.mcp_tool_use' ||
				e.type === 'agent.custom_tool_use';
			const name = (e.data as { name?: string; tool_name?: string }).name ??
				(e.data as { tool_name?: string }).tool_name ??
				'';
			const last = out[out.length - 1];
			const lastIsTool =
				last &&
				(last.event.type === 'agent.tool_use' ||
					last.event.type === 'agent.mcp_tool_use' ||
					last.event.type === 'agent.custom_tool_use');
			const lastName = last
				? (last.event.data as { name?: string; tool_name?: string }).name ??
					(last.event.data as { tool_name?: string }).tool_name ??
					''
				: '';
			if (isTool && lastIsTool && name === lastName && name) {
				last.count += 1;
				last.children.push(e);
				// Representative = latest invocation (its latest input wins in
				// the detail panel header).
				last.event = e;
			} else {
				out.push({ event: e, children: [e], count: 1 });
			}
		}
		return out;
	});
	// Find the batch whose representative is the currently-selected event so
	// the detail panel can render its children as a stack.
	const selectedBatch = $derived.by(() => {
		if (!selectedEvent) return null;
		return (
			batchedEvents.find((b) => String(b.event.id) === String(selectedEvent.id)) ?? null
		);
	});
	// Augment the row list with "Session idle · {duration}" separators between
	// turns so the user can see at a glance when the session went quiet between
	// the agent's response and the next user message. Matches CMA's transcript
	// affordance.
	type ListRow =
		| { kind: 'batch'; key: string; batch: BatchedEvent }
		| { kind: 'separator'; key: string; sinceMs: number };
	const listRows = $derived.by<ListRow[]>(() => {
		if (viewMode === 'debug') {
			return batchedEvents.map((b) => ({ kind: 'batch' as const, key: String(b.event.id), batch: b }));
		}
		const out: ListRow[] = [];
		let prev: BatchedEvent | null = null;
		for (const b of batchedEvents) {
			if (prev && b.event.type.startsWith('user.')) {
				const sinceMs =
					new Date(b.event.createdAt).getTime() - new Date(prev.event.createdAt).getTime();
				if (Number.isFinite(sinceMs) && sinceMs >= 30_000) {
					out.push({
						kind: 'separator' as const,
						key: `sep:${prev.event.id}:${b.event.id}`,
						sinceMs
					});
				}
			}
			out.push({ kind: 'batch' as const, key: String(b.event.id), batch: b });
			prev = b;
		}
		return out;
	});
	function fmtIdleGap(ms: number): string {
		if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
		if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
		if (ms < 86_400_000) {
			const h = Math.floor(ms / 3_600_000);
			const m = Math.floor((ms % 3_600_000) / 60_000);
			return m > 0 ? `${h}h ${m}m` : `${h}h`;
		}
		const d = Math.floor(ms / 86_400_000);
		const h = Math.floor((ms % 86_400_000) / 3_600_000);
		return h > 0 ? `${d}d ${h}h` : `${d}d`;
	}
	// Every event type seen in this session, for the "All events" filter
	// dropdown. Order matches first-seen order so the menu stays stable
	// across turns.
	const eventTypeSet = $derived.by(() => {
		const seen: string[] = [];
		const set = new Set<string>();
		for (const e of events) {
			if (!set.has(e.type)) {
				set.add(e.type);
				seen.push(e.type);
			}
		}
		return seen;
	});
	let isConnected = $state(false);
	let isConsolidating = $state(false);
	let streamError = $state<string | null>(null);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let mlflowGroup = $state<SessionMlflowGroup | null>(null);
	let mlflowGroupKey = $state('');
	let runtimeConfig = $state<RuntimeConfigCloudEvent | null>(null);
	let runtimeConfigKey = $state('');
	let runtimeConfigLoading = $state(false);
	let runtimeConfigError = $state<string | null>(null);
	let input = $state('');
	let sending = $state(false);
	let editingTitle = $state(false);
	let titleDraft = $state('');
	// Per-tool denial state: toolUseId → {open: did user click Deny once, reason: textarea draft}
	let denyDrafts = $state<Record<string, { open: boolean; reason: string }>>({});
	// Wave 4.18: amber banner for vault credentials expiring within 24h
	let expiringCreds = $state<
		Array<{ vaultId: string; credId: string; displayName: string; expiresAt: string }>
	>([]);
	// Liveness of the per-session runtime/workspace sandbox. Sessions persist
	// sandbox names forever, but the backing pod/CR may be deleted separately.
	let sandboxAlive = $state<'unknown' | 'alive' | 'terminated'>('unknown');
	let sandboxDeleting = $state(false);
	let sandboxDeleteError = $state<string | null>(null);
	// CMA-style compact event list: a single selected event is expanded in
	// the right-side detail panel. When null, we auto-select the newest
	// event so the panel is never empty once events start flowing.
	let selectedEventId = $state<string | null>(null);
	let rightRailOpen = $state(true);
	// CMA's "All events" filter is a multi-select — pick which event types
	// to show. Default: all distinct kinds present in the stream.
	let visibleKinds = $state<Set<string>>(new Set());
	let eventFilterOpen = $state(false);
	let searchText = $state('');
	const sessionStartMs = $derived.by(() => {
		if (!session?.createdAt) return null;
		return new Date(session.createdAt).getTime();
	});
	const selectedEvent = $derived.by(() => {
		const list = displayEvents;
		if (list.length === 0) return null;
		const explicit = list.find((e) => String(e.id) === selectedEventId);
		return explicit ?? list[list.length - 1];
	});
	const primarySandboxName = $derived(
		session?.runtimeSandboxName ?? session?.workspaceSandboxName ?? session?.sandboxName ?? null
	);
	const hasDestroyableSessionSandbox = $derived(
		Boolean(session?.runtimeSandboxName || session?.workspaceSandboxName)
	);
	const primarySandboxLabel = $derived.by(() => {
		if (session?.runtimeSandboxName) return 'Session runtime sandbox';
		if (session?.workspaceSandboxName) return 'Session sandbox';
		return 'Sandbox runtime';
	});
	// Find the matching tool_use ↔ tool_result mate so EventDetailPanel can
	// render both halves together (input + output) regardless of which row
	// the user clicked. Returns null when the selected event isn't a tool
	// event or the mate hasn't streamed in yet.
	const selectedPairedResult = $derived.by(() => {
		if (!selectedEvent) return null;
		const pair = findToolPair(events, selectedEvent);
		if (pair.start === selectedEvent) return pair.end ?? null;
		if (pair.end === selectedEvent) return pair.start ?? null;
		return null;
	});
	// Session duration — from createdAt to the most recent event (or now if
	// still streaming). Used for the CMA-shape metadata pill.
	const sessionDurationMs = $derived.by(() => {
		if (!sessionStartMs) return null;
		if (events.length === 0) return null;
		const last = events[events.length - 1];
		const endTs = last ? new Date(last.createdAt).getTime() : Date.now();
		return endTs - sessionStartMs;
	});
	// Total token budget across the whole session. Starts from session.usage
	// when the server has aggregated it, but falls back to summing per-event
	// usage whenever the server value is zero (common pattern for still-
	// running sessions where session_workflow hasn't flushed the running
	// total yet).
	const totalTokens = $derived.by(() => {
		let input = 0;
		let output = 0;
		for (const e of events) {
			const d = e.data as { usage?: { input_tokens?: number; output_tokens?: number } };
			if (d?.usage) {
				input += d.usage.input_tokens ?? 0;
				output += d.usage.output_tokens ?? 0;
			}
		}
		const u = session?.usage as
			| { input_tokens?: number; output_tokens?: number }
			| undefined;
		if (u && ((u.input_tokens ?? 0) > 0 || (u.output_tokens ?? 0) > 0)) {
			// Server-aggregated numbers win when present.
			return {
				input: u.input_tokens ?? input,
				output: u.output_tokens ?? output
			};
		}
		return { input, output };
	});

	function formatSessionDuration(ms: number | null): string {
		if (ms === null || ms <= 0) return '—';
		if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
		const mins = Math.floor(ms / 60_000);
		const secs = Math.floor((ms % 60_000) / 1000);
		if (mins < 60) return `${mins}m ${secs.toString().padStart(2, '0')}s`;
		const hours = Math.floor(mins / 60);
		return `${hours}h ${(mins % 60).toString().padStart(2, '0')}m`;
	}
	function fmtTokensCompact(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
		return String(n);
	}
	function formatCreatedAt(iso: string | null | undefined): string {
		if (!iso) return '';
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
		return new Date(iso).toLocaleDateString();
	}
	function shortMlflowId(value: string | null | undefined): string {
		const text = value?.trim() ?? '';
		if (!text) return '—';
		return text.length > 16 ? `${text.slice(0, 12)}…` : text;
	}
	function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
		return Boolean(value && typeof value === 'object' && !Array.isArray(value));
	}
	function coerceRuntimeConfig(value: unknown): RuntimeConfigCloudEvent | null {
		if (!isRuntimeRecord(value)) return null;
		if (
			value.specversion !== '1.0' ||
			value.type !== 'io.workflow-builder.session.runtime_config.v1' ||
			typeof value.id !== 'string' ||
			!isRuntimeRecord(value.data)
		) {
			return null;
		}
		return value as RuntimeConfigCloudEvent;
	}
	function runtimeSection(name: keyof RuntimeConfigData): Record<string, unknown> {
		const section = runtimeConfig?.data?.[name];
		return isRuntimeRecord(section) ? section : {};
	}
	function runtimeText(value: unknown): string | null {
		return typeof value === 'string' && value.trim() ? value.trim() : null;
	}
	function runtimeNumber(value: unknown): number | null {
		return typeof value === 'number' && Number.isFinite(value) ? value : null;
	}
	function runtimeCount(section: Record<string, unknown>, key: string): number | null {
		const direct = runtimeNumber(section[key]);
		if (direct !== null) return direct;
		const value = section[key.replace(/Count$/, 's')];
		return Array.isArray(value) ? value.length : null;
	}
	function runtimeConfigJson(): string {
		if (!runtimeConfig) return '';
		try {
			return JSON.stringify(runtimeConfig, null, 2);
		} catch {
			return String(runtimeConfig);
		}
	}
	function applyRuntimeConfig(event: RuntimeConfigCloudEvent | null) {
		if (!event || event.id === runtimeConfigKey) return;
		runtimeConfig = event;
		runtimeConfigKey = event.id;
		runtimeConfigError = null;
	}
	async function loadRuntimeConfig() {
		runtimeConfigLoading = true;
		runtimeConfigError = null;
		try {
			const res = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/runtime-config`);
			if (res.status === 404) {
				runtimeConfig = null;
				runtimeConfigKey = '';
				return;
			}
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			applyRuntimeConfig(coerceRuntimeConfig(await res.json().catch(() => null)));
		} catch (err) {
			runtimeConfigError = err instanceof Error ? err.message : String(err);
		} finally {
			runtimeConfigLoading = false;
		}
	}

	async function copyAllEvents() {
		const payload = displayEvents.map((e) => ({
			id: e.id,
			type: e.type,
			timestamp: e.createdAt,
			data: e.data
		}));
		try {
			await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
		} catch {
			/* clipboard blocked */
		}
	}
	function downloadEvents() {
		const payload = displayEvents.map((e) => ({
			id: e.id,
			sequence: e.sequence,
			type: e.type,
			timestamp: e.createdAt,
			data: e.data
		}));
		const jsonl = payload.map((o) => JSON.stringify(o)).join('\n');
		const blob = new Blob([jsonl], { type: 'application/jsonl' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${sessionId}.events.jsonl`;
		a.click();
		URL.revokeObjectURL(url);
	}
	function toggleKindFilter(type: string) {
		const next = new Set(visibleKinds);
		if (next.has(type)) next.delete(type);
		else next.add(type);
		visibleKinds = next;
	}
	// Auto-follow newest while streaming: if the user hasn't pinned a
	// selection, roll the selected pointer forward as new events arrive.
	$effect(() => {
		if (selectedEventId !== null) return;
		const last = displayEvents[displayEvents.length - 1];
		if (last) {
			// no-op: selectedEvent derived handles the default. This effect only
			// exists to keep the reactive chain attached to displayEvents.
			void last.id;
		}
	});

	let stream = $state<SessionStreamStore | null>(null);
	let unsub: (() => void) | null = null;
	let scrollEl: HTMLDivElement | undefined = $state();

	async function initialLoad() {
		loading = true;
		try {
			const res = await fetch(`/api/v1/sessions/${sessionId}`);
			if (!res.ok) {
				errorMessage = `Failed to load session (${res.status})`;
				return;
			}
			const data = (await res.json()) as { session: SessionDetail };
			session = data.session;
			titleDraft = session.title ?? '';
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	async function loadMlflowGroup(id: string) {
		try {
			const res = await fetch(
				`/api/observability/mlflow/sessions/${encodeURIComponent(id)}?format=json`
			);
			if (!res.ok) {
				mlflowGroup = null;
				return;
			}
			mlflowGroup = (await res.json()) as SessionMlflowGroup;
		} catch {
			mlflowGroup = null;
		}
	}

	$effect(() => {
		const key = session
			? [
					session.id,
					session.mlflowExperimentId ?? '',
					session.mlflowRunId ?? '',
					session.mlflowSessionId ?? ''
				].join(':')
			: '';
		if (key === mlflowGroupKey) return;
		mlflowGroupKey = key;
		if (!session || (!session.mlflowExperimentId && !session.mlflowRunId)) {
			mlflowGroup = null;
			return;
		}
		void loadMlflowGroup(session.id);
	});

	// Prev/next session navigation. We cache the caller's session-id list
	// (most recent 50) once on load so the chevrons iterate without a
	// round-trip per click. Updated whenever the session itself changes.
	let neighborSessions = $state<string[]>([]);
	const prevSessionId = $derived.by(() => {
		const idx = neighborSessions.indexOf(sessionId);
		if (idx < 0) return null;
		return neighborSessions[idx + 1] ?? null;
	});
	const nextSessionId = $derived.by(() => {
		const idx = neighborSessions.indexOf(sessionId);
		if (idx <= 0) return null;
		return neighborSessions[idx - 1] ?? null;
	});
	async function loadNeighborSessions() {
		try {
			const res = await fetch('/api/v1/sessions?limit=50');
			if (!res.ok) return;
			const data = (await res.json()) as { sessions: Array<{ id: string }> };
			neighborSessions = (data.sessions ?? []).map((s) => s.id);
		} catch {
			/* non-fatal */
		}
	}

	async function checkSandboxLiveness() {
		if (!session) {
			sandboxAlive = 'unknown';
			return;
		}
		const name = primarySandboxName;
		if (!name) {
			sandboxAlive = 'unknown';
			return;
		}
		try {
			const res = await fetch(`/api/sandboxes/${encodeURIComponent(name)}`);
			sandboxAlive = res.ok ? 'alive' : 'terminated';
		} catch {
			sandboxAlive = 'unknown';
		}
	}

	async function checkExpiringCreds() {
		if (!session || session.vaultIds.length === 0) {
			expiringCreds = [];
			return;
		}
		const threshold = Date.now() + 24 * 3_600_000;
		try {
			const results = await Promise.all(
				session.vaultIds.map((vid) =>
					fetch(`/api/v1/vaults/${vid}/credentials`)
						.then((r) => (r.ok ? r.json() : { credentials: [] }))
						.catch(() => ({ credentials: [] }))
				)
			);
			const out: typeof expiringCreds = [];
			for (let i = 0; i < results.length; i++) {
				const vid = session.vaultIds[i];
				const creds = (results[i]?.credentials ?? []) as Array<{
					id: string;
					displayName: string;
					expiresAt: string | null;
				}>;
				for (const c of creds) {
					if (!c.expiresAt) continue;
					const t = new Date(c.expiresAt).getTime();
					if (t > 0 && t < threshold) {
						out.push({
							vaultId: vid,
							credId: c.id,
							displayName: c.displayName,
							expiresAt: c.expiresAt
						});
					}
				}
			}
			expiringCreds = out;
		} catch {
			// non-fatal
		}
	}

	onMount(() => {
		void (async () => {
			await initialLoad();
			void checkExpiringCreds();
			void checkSandboxLiveness();
			void loadNeighborSessions();
			void loadRuntimeConfig();
			void refreshRuntimeFlags();
			runtimeTimer = setInterval(() => {
				void refreshRuntimeFlags();
			}, 10_000);
		})();
		stream = createSessionStream(sessionId);
		unsub = stream.subscribe((state) => {
			isConnected = state.isConnected;
			isConsolidating = state.isConsolidating;
			streamError = state.error;
			events = state.events;
			inFlightPartials = state.inFlightPartials;
			if (state.session) session = state.session;
			queueScroll();
		});
	});

	$effect(() => {
		const latest = [...events].reverse().find((event) => event.type === 'session.runtime_config');
		applyRuntimeConfig(coerceRuntimeConfig(latest?.data));
	});

	// Re-probe sandbox liveness whenever session transitions to terminated.
	let lastKnownStatus = $state<string | null>(null);
	$effect(() => {
		const status = session?.status ?? null;
		if (status !== lastKnownStatus) {
			lastKnownStatus = status;
			if (status === 'terminated' || status === 'idle') {
				void checkSandboxLiveness();
			}
		}
	});

	onDestroy(() => {
		if (unsub) unsub();
		stream?.dispose();
		if (runtimeTimer) clearInterval(runtimeTimer);
	});

	function queueScroll() {
		queueMicrotask(() => {
			if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
		});
	}

	async function send() {
		if (!input.trim() || sending) return;
		const text = input;
		input = '';
		sending = true;
		try {
			const res = await fetch(`/api/v1/sessions/${sessionId}/events`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					events: [
						{
							type: 'user.message',
							content: [{ type: 'text', text }]
						}
					]
				})
			});
			if (!res.ok) {
				errorMessage = `Send failed (${res.status}): ${await res.text()}`;
				input = text;
			}
		} finally {
			sending = false;
		}
	}

	async function interrupt() {
		// Route through the vetted lifecycle controller (mode=interrupt): scope-checked,
		// fail-closed, and it still raises the cooperative user.interrupt the runtime
		// understands — instead of POSTing the raw external event past the controller.
		const res = await fetch(`/api/v1/sessions/${sessionId}/control/interrupt`, {
			method: 'POST'
		});
		if (!res.ok) {
			const b = (await res.json().catch(() => ({}))) as { message?: string };
			errorMessage = b?.message ?? `Interrupt failed (${res.status})`;
		}
	}

	async function confirmTool(toolUseId: string, allow: boolean, denyMessage?: string) {
		await fetch(`/api/v1/sessions/${sessionId}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				events: [
					{
						type: 'user.tool_confirmation',
						tool_use_id: toolUseId,
						result: allow ? 'allow' : 'deny',
						...(denyMessage ? { deny_message: denyMessage } : {})
					}
				]
			})
		});
	}

	let forking = $state(false);

	// SessionConfigDrawer state — for "Fork with edits". The drawer needs the
	// session's effective base agent (id+config). Lazy-fetch on first open and
	// cache; the agent rarely changes mid-session.
	let forkDrawerOpen = $state(false);
	let baseAgentForDrawer = $state<AgentDetail | null>(null);
	let baseAgentLoading = $state(false);
	let rerunning = $state(false);

	async function ensureBaseAgentLoaded() {
		if (baseAgentForDrawer || !session?.agentId) return;
		baseAgentLoading = true;
		try {
			const res = await fetch(`/api/agents/${session.agentId}`);
			if (res.ok) {
				const body = (await res.json()) as { agent: AgentDetail };
				baseAgentForDrawer = body.agent;
			}
		} finally {
			baseAgentLoading = false;
		}
	}

	async function openForkDrawer() {
		await ensureBaseAgentLoaded();
		forkDrawerOpen = true;
	}

	async function rerunSameConfig() {
		if (rerunning || !session) return;
		rerunning = true;
		try {
			const res = await fetch('/api/v1/sessions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					agentId: session.agentId,
					agentVersion: session.agentVersion ?? undefined,
					environmentId: session.environmentId ?? undefined,
					vaultIds: session.vaultIds
				})
			});
			if (!res.ok) {
				console.error('[rerun] failed', await res.text());
				return;
			}
			const body = (await res.json()) as { session: { id: string } };
			if (body.session?.id) {
				goto(`/workspaces/${slug}/sessions/${body.session.id}`);
			}
		} finally {
			rerunning = false;
		}
	}

	async function forkFromEvent(sequence: number) {
		if (forking) return;
		forking = true;
		try {
			const res = await fetch(`/api/v1/sessions/${sessionId}/fork`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ fromSequence: sequence })
			});
			if (!res.ok) {
				console.error('[fork] failed', await res.text());
				return;
			}
			const body = (await res.json()) as { sessionId: string };
			if (body.sessionId) goto(`/workspaces/${slug}/sessions/${body.sessionId}`);
		} finally {
			forking = false;
		}
	}

	async function saveTitle() {
		if (!session) return;
		const res = await fetch(`/api/v1/sessions/${sessionId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: titleDraft })
		});
		if (res.ok) {
			const data = (await res.json()) as { session: SessionDetail };
			session = data.session;
			editingTitle = false;
		}
	}

	let coordinatorOwner = $state<{ kind: 'benchmarkRun' | 'evalRun'; runId: string } | null>(null);
	let stopBusy = $state(false);
	// "stopping" = accepted (202) but the durable terminate is still converging.
	let stopConverging = $state(false);
	async function pollStopStatus() {
		for (let i = 0; i < 100 && stopConverging; i++) {
			await new Promise((r) => setTimeout(r, 3000));
			try {
				const res = await fetch(`/api/v1/sessions/${sessionId}/stop/status`);
				if (!res.ok) break;
				const b = (await res.json().catch(() => ({}))) as { state?: string };
				if (b?.state === 'confirmed' || b?.state === 'notFound') break;
			} catch {
				/* transient — keep polling */
			}
		}
		stopConverging = false;
	}
	async function stopRun(mode: 'purge' | 'reset') {
		if (!session || stopBusy || stopConverging) return;
		const label = mode === 'reset' ? 'Stop & reset' : 'Stop';
		if (
			!confirm(
				`${label} this run? This terminates the durable run${mode === 'reset' ? ', purges its state,' : ''} and reaps its sandbox.`
			)
		)
			return;
		stopBusy = true;
		try {
			const res = await fetch(`/api/v1/sessions/${sessionId}/stop`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mode })
			});
			const b = (await res.json().catch(() => ({}))) as {
				message?: string;
				state?: string;
				error?: string;
				ownedBy?: 'benchmarkRun' | 'evalRun';
				runId?: string;
			};
			if (res.status === 409 && b?.error === 'coordinator_owned' && b.ownedBy && b.runId) {
				// Single stop authority: this session is a benchmark/eval instance —
				// redirect to the owning run's cancel surface instead of fighting the
				// coordinator (mirrors the workflow-run page).
				coordinatorOwner = { kind: b.ownedBy, runId: b.runId };
				errorMessage =
					b.message ?? 'This run is managed by its benchmark/evaluation run — cancel it there.';
			} else if (res.status === 202 || b?.state === 'stopping') {
				stopConverging = true;
				void pollStopStatus();
			} else if (!res.ok) {
				errorMessage = b?.message ?? `${label} did not confirm (${res.status})`;
			}
		} finally {
			stopBusy = false;
		}
	}

	async function archive() {
		if (!session) return;
		const res = await fetch(`/api/v1/sessions/${sessionId}`, { method: 'PATCH' });
		if (res.ok) {
			goto(`/workspaces/${slug}/sessions`);
		} else {
			const b = (await res.json().catch(() => ({}))) as { message?: string };
			errorMessage =
				b?.message ??
				(res.status === 409
					? 'Stop the run before archiving this session.'
					: `Archive failed (${res.status})`);
		}
	}

	async function destroySessionSandbox() {
		if (!session || !hasDestroyableSessionSandbox || sandboxDeleting) return;
		const name = session.runtimeSandboxName ?? session.workspaceSandboxName;
		if (!name) return;
		if (!confirm(`Destroy sandbox ${name}?`)) return;
		sandboxDeleting = true;
		sandboxDeleteError = null;
		try {
			const res = await fetch(`/api/v1/sessions/${sessionId}/sandbox`, {
				method: 'DELETE'
			});
			const body = (await res.json().catch(() => ({}))) as {
				message?: string;
				error?: string;
			};
			if (!res.ok) {
				sandboxDeleteError =
					body.message ?? body.error ?? `Destroy sandbox failed (${res.status})`;
				return;
			}
			sandboxAlive = 'terminated';
			void checkSandboxLiveness();
		} catch (err) {
			sandboxDeleteError = err instanceof Error ? err.message : String(err);
		} finally {
			sandboxDeleting = false;
		}
	}

	async function setModel(modelSpec: string) {
		const res = await fetch(`/api/v1/sessions/${sessionId}/control/set-model`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ modelSpec })
		});
		if (!res.ok) {
			errorMessage = `Set-model failed (${res.status})`;
		}
	}

	async function setPermissionMode(mode: 'bypass' | 'default') {
		const res = await fetch(`/api/v1/sessions/${sessionId}/control/set-permission-mode`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ mode })
		});
		if (!res.ok) {
			errorMessage = `Set-permission-mode failed (${res.status})`;
		}
	}

	let bypassEnabled = $state(false);

	function formatEvent(event: SessionEventEnvelope) {
		const { type, data } = event;
		switch (type) {
			case 'user.message': {
				const content = (data as { content?: Array<{ text?: string }> }).content ?? [];
				return {
					kind: 'user' as const,
					text: content.map((c) => c.text ?? '').join('')
				};
			}
			case 'agent.message': {
				const content = (data as { content?: Array<{ text?: string }> }).content ?? [];
				return {
					kind: 'agent' as const,
					text: content.map((c) => c.text ?? '').join('')
				};
			}
			case 'agent.thinking': {
				// CMA shape: data.content = [{type:"text", text:"..."}]
				const content = (data as { content?: Array<{ text?: string }> }).content ?? [];
				const text = content.map((c) => c.text ?? '').join('').trim();
				return { kind: 'thinking' as const, text };
			}
			case 'agent.tool_use':
			case 'agent.mcp_tool_use':
				return {
					kind: 'tool_use' as const,
					name: String(
						(data as { name?: unknown }).name ?? (data as { tool_name?: unknown }).tool_name ?? ''
					),
					input: (data as { input?: unknown }).input,
					needsApproval:
						(data as { evaluated_permission?: string }).evaluated_permission === 'ask',
					toolUseId: event.id
				};
			case 'agent.tool_result':
			case 'agent.mcp_tool_result':
				return { kind: 'tool_result' as const, data };
			case 'agent.custom_tool_use':
				return {
					kind: 'custom_tool_use' as const,
					name: String((data as { name?: unknown }).name ?? ''),
					input: (data as { input?: unknown }).input,
					toolUseId: event.id
				};
			case 'session.status_idle': {
				const sr = (data as { stop_reason?: { type?: string } }).stop_reason;
					const friendly =
						sr?.type === 'end_turn'
							? 'finished the turn'
							: sr?.type === 'requires_action'
								? 'needs your input'
								: sr?.type === 'retries_exhausted'
									? 'retries exhausted'
									: sr?.type === 'interrupted'
										? 'was interrupted'
										: sr?.type === 'terminated'
											? 'was terminated'
											: 'idle';
					return {
						kind: 'status' as const,
						text: `Agent ${friendly}`
					};
				}
			case 'session.status_running':
				return { kind: 'status' as const, text: 'Running…' };
			case 'session.status_rescheduled':
				return { kind: 'status' as const, text: 'Rescheduled' };
			case 'span.model_request_start':
			case 'span.model_request_end':
				return { kind: 'span' as const };
			default:
				return {
					kind: 'other' as const,
					type
				};
		}
	}
</script>

<div class="flex flex-col h-screen">
	<!-- Breadcrumb strip: sessions → id (copy) + prev/next nav arrows. -->
	<div class="border-b bg-muted/30 px-4 py-1.5 flex items-center gap-2 text-xs text-muted-foreground">
		<a href="/workspaces/{slug}/sessions" class="hover:text-foreground">Sessions</a>
		<span class="text-muted-foreground/60">/</span>
		{#if session}
			<CopyIdButton value={session.id} />
		{:else}
			<span>Loading…</span>
		{/if}
		<div class="ml-2 flex items-center gap-0.5">
			<Button
				variant="ghost"
				size="icon"
				class="size-6"
				title="Newer session"
				disabled={!nextSessionId}
				onclick={() => nextSessionId && goto(`/workspaces/${slug}/sessions/${nextSessionId}`)}
			>
				<ChevronUp class="size-3.5" />
			</Button>
			<Button
				variant="ghost"
				size="icon"
				class="size-6"
				title="Older session"
				disabled={!prevSessionId}
				onclick={() => prevSessionId && goto(`/workspaces/${slug}/sessions/${prevSessionId}`)}
			>
				<ChevronDown class="size-3.5" />
			</Button>
		</div>
		<div class="ml-auto flex items-center gap-2">
			<Badge variant={isConnected ? 'secondary' : 'outline'} class="text-[10px]">
				{isConsolidating ? 'catching up…' : isConnected ? 'streaming' : 'connecting…'}
			</Badge>
			<AgentModelSelector
				value={null}
				placeholder="Switch model"
				triggerClass="h-7 w-[210px] text-xs"
				onSelect={(modelSpec) => setModel(modelSpec)}
			/>
			<Button
				variant="outline"
				size="sm"
				class="h-7 gap-1"
				disabled={rerunning}
				onclick={rerunSameConfig}
				title="Start a new session with the same agent + config"
			>
				{#if rerunning}<Loader2 class="size-3 animate-spin" />{:else}<RotateCw class="size-3" />{/if}
				Re-run
			</Button>
			<Button
				variant="outline"
				size="sm"
				class="h-7 gap-1"
				disabled={baseAgentLoading || forking}
				onclick={openForkDrawer}
				title="Fork this session with edits to the agent config"
			>
				{#if baseAgentLoading}<Loader2 class="size-3 animate-spin" />{:else}<GitBranchIcon class="size-3" />{/if}
				Fork with edits
			</Button>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button variant="outline" size="sm" class="h-7" {...props} title="Session actions">
							Actions <ChevronDown class="size-3" />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-72">
					<DropdownMenu.Item
						onSelect={() => interrupt()}
						disabled={session?.status !== 'running'}
					>
						<Square class="size-3.5" /> Send interrupt
					</DropdownMenu.Item>
					{#if coordinatorOwner}
						<DropdownMenu.Item
							onSelect={() =>
								goto(
									coordinatorOwner?.kind === 'benchmarkRun'
										? `/workspaces/${slug}/benchmarks?run=${encodeURIComponent(coordinatorOwner.runId)}`
										: `/workspaces/${slug}/evaluations`
								)}
						>
							<Square class="size-3.5" /> Managed by {coordinatorOwner.kind === 'benchmarkRun'
								? 'benchmark'
								: 'evaluation'} run →
						</DropdownMenu.Item>
					{:else}
						<DropdownMenu.Item
							onSelect={() => stopRun('purge')}
							disabled={session?.status === 'terminated' || stopBusy || stopConverging}
							class="text-destructive focus:text-destructive"
						>
							<Square class="size-3.5" /> {stopBusy || stopConverging ? 'Stopping…' : 'Stop run'}
						</DropdownMenu.Item>
						<DropdownMenu.Item
							onSelect={() => stopRun('reset')}
							disabled={session?.status === 'terminated' || stopBusy || stopConverging}
							class="text-destructive focus:text-destructive"
						>
							<Square class="size-3.5" /> Stop &amp; reset
						</DropdownMenu.Item>
					{/if}
					<DropdownMenu.Item onSelect={() => downloadEvents()}>
						<Download class="size-3.5" /> Download events…
					</DropdownMenu.Item>
					<DropdownMenu.Separator />
					<div class="px-2 py-1.5 flex items-center justify-between text-xs">
						<Label for="bypass-toggle" class="text-xs">Bypass permissions</Label>
						<Switch
							id="bypass-toggle"
							checked={bypassEnabled}
							onCheckedChange={(v) => {
								bypassEnabled = v;
								setPermissionMode(v ? 'bypass' : 'default');
							}}
						/>
					</div>
					<DropdownMenu.Separator />
					<DropdownMenu.Item onSelect={archive} class="text-destructive focus:text-destructive">
						<Archive class="size-3.5" /> Archive session
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
			<Button variant="outline" size="sm" class="h-7" disabled title="Coming soon">
				<Sparkles class="size-3.5" /> Ask Claude
			</Button>
		</div>
	</div>

	{#if workflowRunContext}
		<!-- Breadcrumb: this session was spawned by a workflow durable/run node. -->
		<div class="border-b px-4 py-2 text-xs text-muted-foreground flex items-center gap-1.5">
			<Workflow class="size-3" />
			<span>Workflow run</span>
			<span class="text-muted-foreground/60">·</span>
			<a
				href="/workspaces/{slug}/workflows/{workflowRunContext.workflowId}"
				class="hover:underline truncate max-w-[220px] text-foreground"
				title={workflowRunContext.workflowName}
			>
				{workflowRunContext.workflowName}
			</a>
			<span class="text-muted-foreground/60">·</span>
			<a
				href="/workspaces/{slug}/workflows/{workflowRunContext.workflowId}/runs/{workflowRunContext.executionId}"
				class="hover:underline font-mono text-[11px] text-foreground"
				title="Open workflow run"
			>
				#{workflowRunContext.executionId}
			</a>
		</div>
	{/if}

	<!-- Title + inline metadata pill row. Matches CMA: session id (big),
	     status pill, agent · environment · duration · tokens · created. -->
	<header class="border-b px-4 py-3 flex items-center gap-3 flex-wrap">
		{#if editingTitle}
			<Input bind:value={titleDraft} placeholder="Session title" class="max-w-md" />
			<Button size="sm" onclick={saveTitle}>
				<Save class="size-3" /> Save
			</Button>
			<Button size="sm" variant="ghost" onclick={() => (editingTitle = false)}>
				<X class="size-3" />
			</Button>
		{:else}
			<button
				type="button"
				class="text-left"
				onclick={() => {
					editingTitle = true;
					titleDraft = session?.title ?? '';
				}}
				title="Click to rename"
			>
				<h1 class="font-semibold text-lg leading-tight tracking-tight truncate max-w-[520px]">
					{session?.title ?? session?.id ?? 'Loading…'}
				</h1>
			</button>
			{#if session}
				<Badge variant="outline" class="text-[10px] capitalize bg-muted">
					{session.status}
				</Badge>
				<span class="text-muted-foreground/60">·</span>
				{#if session.agentId}
					{@const agentHit = agents.map.get(session.agentId)}
					<a
						href="/workspaces/{slug}/agents/{session.agentId}"
						class="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 text-xs hover:bg-muted transition-colors"
						title={agentHit ? `Open agent · ${session.agentId}` : 'Open agent'}
					>
						<Bot class="size-3 text-muted-foreground" />
						<span class="truncate max-w-[200px]">{agentHit?.name ?? session.agentId}</span>
					</a>
					{#if agentRegistry}
						<RegistryStatusBadge
							mini
							status={agentRegistry.status}
							error={agentRegistry.error}
							syncedAt={agentRegistry.syncedAt}
						/>
					{/if}
				{/if}
				{#if session.environmentId}
					<a
						href="/workspaces/{slug}/environments/{session.environmentId}"
						class="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 text-xs hover:bg-muted transition-colors"
						title="Open environment"
					>
						<Cloud class="size-3 text-muted-foreground" />
						<span class="truncate max-w-[160px]">{session.environmentId}</span>
					</a>
				{/if}
				<span class="text-muted-foreground/60">·</span>
				<span class="inline-flex items-center gap-1 text-xs text-muted-foreground">
					<Clock class="size-3" />
					{formatSessionDuration(sessionDurationMs)}
				</span>
				<span class="text-muted-foreground/60">·</span>
				<span
					class="inline-flex items-center gap-1 text-xs text-muted-foreground"
					title="{totalTokens.input.toLocaleString()} input tokens / {totalTokens.output.toLocaleString()} output tokens"
				>
					<FileText class="size-3" />
					{fmtTokensCompact(totalTokens.input)} / {fmtTokensCompact(totalTokens.output)}
				</span>
				<span class="text-muted-foreground/60">·</span>
				<span class="inline-flex items-center gap-1 text-xs text-muted-foreground">
					<Clock class="size-3" />
					{formatCreatedAt(session.createdAt)}
				</span>
			{/if}
		{/if}
	</header>

	{#if errorMessage || streamError}
		<Alert variant="destructive" class="m-3">
			<AlertDescription>{errorMessage ?? streamError}</AlertDescription>
		</Alert>
	{/if}

	{#if expiringCreds.length > 0}
		<Alert
			class="mx-3 mt-3 border-amber-500/50 bg-amber-500/5 text-amber-900 dark:text-amber-200"
		>
			<AlertDescription class="flex items-center flex-wrap gap-x-2 gap-y-1">
				<Clock class="size-4 inline" />
				{expiringCreds.length} credential{expiringCreds.length === 1 ? '' : 's'}
				expire{expiringCreds.length === 1 ? 's' : ''} within 24h:
				{#each expiringCreds as c, i (c.credId)}
					<a href="/workspaces/{slug}/credentials/{c.vaultId}" class="underline">{c.displayName}</a
					>{#if i < expiringCreds.length - 1},&nbsp;{/if}
				{/each}
				<span class="text-[11px] opacity-70 ml-auto">
					Rotate now on the vault page to refresh the OAuth tokens.
				</span>
			</AlertDescription>
		</Alert>
	{/if}

	<div
		class="flex-1 grid grid-cols-1 overflow-hidden {rightRailOpen
			? 'lg:grid-cols-[1fr_320px]'
			: ''}"
	>
		<div class="flex flex-col overflow-hidden">
			<div class="border-b px-4 py-2 flex items-center gap-2">
				<div class="inline-flex rounded-md border bg-muted/30 p-0.5">
					<button
						type="button"
						class="px-3 py-1 text-xs rounded {viewMode === 'transcript' ? 'bg-background shadow-sm' : 'text-muted-foreground'}"
						onclick={() => (viewMode = 'transcript')}
					>
						Transcript
					</button>
					<button
						type="button"
						class="px-3 py-1 text-xs rounded {viewMode === 'debug' ? 'bg-background shadow-sm' : 'text-muted-foreground'}"
						onclick={() => (viewMode = 'debug')}
					>
						Debug
					</button>
					{#if runtimeFlags?.browserSidecarEnabled}
						<button
							type="button"
							title={runtimeFlags.browserMcpAvailable
								? 'See what the agent is rendering'
								: `Agent not ready yet (phase: ${runtimeFlags.phase ?? 'unknown'})`}
							class="px-3 py-1 text-xs rounded {viewMode === 'browser-state' ? 'bg-background shadow-sm' : 'text-muted-foreground'}"
							disabled={!runtimeFlags.browserMcpAvailable}
							onclick={() => (viewMode = 'browser-state')}
						>
							Browser state
						</button>
					{/if}
					{#if runtimeFlags?.shellAvailable}
						<button
							type="button"
							title="Open a shell into one of the agent pod's containers"
							class="px-3 py-1 text-xs rounded {viewMode === 'shell' ? 'bg-background shadow-sm' : 'text-muted-foreground'}"
							onclick={() => (viewMode = 'shell')}
						>
							Shell
						</button>
					{/if}
					{#if session?.workspaceSandboxName || session?.runtimeSandboxName}
						<button
							type="button"
							title="Open the OpenShell terminal attached to this session"
							class="px-3 py-1 text-xs rounded {viewMode === 'openshell-terminal' ? 'bg-background shadow-sm' : 'text-muted-foreground'}"
							onclick={() => (viewMode = 'openshell-terminal')}
						>
							OpenShell
						</button>
					{/if}
				</div>

				<DropdownMenu.Root bind:open={eventFilterOpen}>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button variant="ghost" size="sm" class="h-7 gap-1 text-xs" {...props}>
								<Filter class="size-3" />
								{visibleKinds.size === 0 ? 'All events' : `${visibleKinds.size} kinds`}
								<ChevronDown class="size-3" />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="start" class="w-64">
						<DropdownMenu.Label class="text-[10px] uppercase tracking-wide text-muted-foreground">
							Event types
						</DropdownMenu.Label>
						{#if eventTypeSet.length === 0}
							<div class="px-2 py-1.5 text-xs text-muted-foreground">
								No events yet.
							</div>
						{:else}
							{#each eventTypeSet as t (t)}
								<DropdownMenu.CheckboxItem
									checked={visibleKinds.size === 0 || visibleKinds.has(t)}
									onCheckedChange={() => toggleKindFilter(t)}
								>
									<code class="text-[11px]">{t}</code>
								</DropdownMenu.CheckboxItem>
							{/each}
						{/if}
						{#if visibleKinds.size > 0}
							<DropdownMenu.Separator />
							<DropdownMenu.Item onSelect={() => (visibleKinds = new Set())}>
								Clear filter
							</DropdownMenu.Item>
						{/if}
					</DropdownMenu.Content>
				</DropdownMenu.Root>

				<div class="relative">
					<Search class="size-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
					<input
						type="text"
						placeholder="Search events"
						bind:value={searchText}
						class="h-7 w-40 rounded border bg-muted/30 pl-6 pr-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
					/>
				</div>

				<span class="ml-1 text-[10px] text-muted-foreground">
					{displayEvents.length} of {events.length}
				</span>

				<div class="ml-auto flex items-center gap-1">
					<Button
						variant="ghost"
						size="icon"
						class="size-7"
						title={rightRailOpen ? 'Hide side panel' : 'Show side panel'}
						onclick={() => (rightRailOpen = !rightRailOpen)}
					>
						<PanelRight class="size-3.5 {rightRailOpen ? '' : 'opacity-50'}" />
					</Button>
					<Button
						variant="ghost"
						size="sm"
						class="h-7 gap-1 text-xs"
						onclick={copyAllEvents}
						title="Copy all events to clipboard as JSON"
					>
						<FileText class="size-3" /> Copy all
					</Button>
					<Button
						variant="ghost"
						size="sm"
						class="h-7 gap-1 text-xs"
						onclick={downloadEvents}
						title="Download events as .jsonl"
					>
						<Download class="size-3" /> Download
					</Button>
				</div>
			</div>
			<!-- CMA-shape timeline bar: one colored segment per event, width
			     proportional to duration. Click a segment to select. -->
			{#if displayEvents.length > 0}
				<div class="border-b px-4 py-2">
					<SessionTimelineBar
						events={displayEvents}
						selectedId={selectedEvent ? String(selectedEvent.id) : null}
						onSelect={(id) => (selectedEventId = id)}
					/>
				</div>
			{/if}

			{#if viewMode === 'browser-state'}
				<div class="flex-1 overflow-hidden p-3">
					<BrowserStatePanel sessionId={session?.id ?? sessionId} />
				</div>
			{:else if viewMode === 'shell'}
				<div class="flex-1 overflow-hidden p-3">
					<PodShellPanel
						sessionId={session?.id ?? sessionId}
						containers={runtimeFlags?.shellContainers ?? []}
					/>
				</div>
			{:else if viewMode === 'openshell-terminal' && (session?.workspaceSandboxName || session?.runtimeSandboxName)}
				<div class="flex-1 overflow-hidden p-3">
					<OpenShellTerminalTabs
						sessionId={session?.id ?? sessionId}
						sandboxName={session.workspaceSandboxName ?? session.runtimeSandboxName ?? ''}
					/>
				</div>
			{:else}
			<div class="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(260px,380px)_1fr] overflow-hidden">
				<!-- Left: compact event list -->
				<div bind:this={scrollEl} class="overflow-y-auto border-r py-1">
					{#if loading}
						<div class="p-3 space-y-1.5">
							<Skeleton class="h-6" />
							<Skeleton class="h-6" />
							<Skeleton class="h-6" />
						</div>
					{:else if displayEvents.length === 0}
						<div class="text-center text-muted-foreground text-sm py-16 px-4">
							{session?.status === 'terminated'
								? 'Session ended with no events.'
								: 'Waiting for the agent to start…'}
						</div>
					{:else}
						<div class="space-y-0.5 px-1.5">
							{#each listRows as row (row.key)}
								{#if row.kind === 'separator'}
									<div class="my-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground/70">
										<span class="h-px flex-1 bg-border/60"></span>
										<span>Session idle · {fmtIdleGap(row.sinceMs)}</span>
										<span class="h-px flex-1 bg-border/60"></span>
									</div>
								{:else}
									{@const batch = row.batch}
									{@const elapsed =
										sessionStartMs !== null
											? new Date(batch.event.createdAt).getTime() - sessionStartMs
											: undefined}
									{@const tokens = tokenAssignments.get(batch.event.id) ?? null}
									<EventRow
										event={batch.event}
										batchCount={batch.count}
										pairedTokens={tokens}
										selected={selectedEvent
											? String(selectedEvent.id) === String(batch.event.id)
											: false}
										elapsedMs={elapsed}
										onClick={() => (selectedEventId = String(batch.event.id))}
									/>
								{/if}
							{/each}
							{#each Object.entries(inFlightPartials) as [key, partial] (key)}
								<div
									class="flex items-start gap-2 rounded border border-dashed border-teal-400/20 bg-teal-500/5 px-2 py-1.5 text-xs"
									title="streaming from the model"
								>
									<span
										class="inline-flex shrink-0 items-center rounded border px-1.5 py-0 text-[9px] font-medium
										{partial.kind === 'thinking'
											? 'bg-emerald-500/25 text-emerald-200 border-emerald-400/20'
											: partial.kind === 'tool_input'
												? 'bg-muted text-muted-foreground border-border'
												: 'bg-teal-500/25 text-teal-200 border-teal-400/20'}"
									>
										{partial.kind === 'thinking'
											? 'Thinking…'
											: partial.kind === 'tool_input'
												? 'Tool…'
												: 'Agent…'}
									</span>
									<span class="flex-1 truncate font-mono text-[11px] text-foreground/80">
										{partial.text.slice(-120)}
									</span>
									<span
										class="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-teal-400/80"
									></span>
								</div>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Right: expanded detail panel. Batches of >1 child render as a
				     collapsible stack so users can drill into each invocation. -->
				<div class="overflow-hidden">
					{#if selectedBatch && selectedBatch.count > 1}
						<BatchDetailPanel
							children={selectedBatch.children}
							{events}
							{sessionStartMs}
							debug={viewMode === 'debug'}
							onClose={() => (selectedEventId = null)}
						/>
					{:else if selectedEvent}
						{@const elapsed =
							sessionStartMs !== null
								? new Date(selectedEvent.createdAt).getTime() - sessionStartMs
								: undefined}
						<EventDetailPanel
							event={selectedEvent}
							pairedResult={selectedPairedResult}
							elapsedMs={elapsed}
							debug={viewMode === 'debug'}
							onClose={() => (selectedEventId = null)}
						/>
					{:else if !loading}
						<div class="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
							Select an event on the left to see its content.
						</div>
					{/if}
				</div>
			</div>
			{/if}

			<div class="border-t p-3 space-y-2">
				<div class="flex gap-2">
					<Textarea
						rows={2}
						placeholder="Send a message…"
						bind:value={input}
						disabled={sending || session?.status === 'terminated'}
						onkeydown={(e) => {
							if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
								e.preventDefault();
								send();
							}
						}}
					/>
					<div class="flex flex-col gap-2">
						{#if session?.status === 'running'}
							<Button variant="outline" size="icon" onclick={interrupt} title="Interrupt">
								<Square class="size-4" />
							</Button>
						{/if}
						<Button
							size="icon"
							disabled={!input.trim() || sending || session?.status === 'terminated'}
							onclick={send}
						>
							<Send class="size-4" />
						</Button>
					</div>
				</div>
				<p class="text-[10px] text-muted-foreground">
					⌘+Enter to send · Interrupt halts the current turn at the next safe boundary.
				</p>
			</div>
		</div>

		<aside
			class="{rightRailOpen
				? 'block'
				: 'hidden'} border-l overflow-y-auto p-4 space-y-4 bg-muted/30"
		>
			{#if session}
				<Card>
					<CardHeader class="pb-2">
						<CardTitle class="text-sm flex items-center gap-2">
							<Bot class="size-4" /> Agent
						</CardTitle>
					</CardHeader>
					<CardContent class="text-xs space-y-1.5">
						<div>
							<a href="/workspaces/{slug}/agents/{session.agentId}" class="text-primary hover:underline">
								{session.agentName ?? session.agentId}
							</a>
						</div>
						<div class="text-muted-foreground">
							{session.agentSlug ?? '—'} · v{session.agentVersion ?? '—'}
						</div>
						{#if session.agentSlug?.startsWith('exp-')}
							<Badge variant="outline" class="border-amber-500/40 text-amber-500 text-[10px]">
								<Sparkles class="size-2.5 mr-1" /> Experiment
							</Badge>
						{:else if session.agentSlug?.startsWith('wf-')}
							<Badge variant="outline" class="border-cyan-500/40 text-cyan-500 text-[10px]">
								<Workflow class="size-2.5 mr-1" /> Workflow ephemeral
							</Badge>
						{/if}
					</CardContent>
				</Card>

				{#if session.environmentId}
					<Card>
						<CardHeader class="pb-2">
							<CardTitle class="text-sm flex items-center gap-2">
								<Layers class="size-4" /> Environment
							</CardTitle>
						</CardHeader>
						<CardContent class="text-xs space-y-1">
							<a
								href="/workspaces/{slug}/environments/{session.environmentId}"
								class="text-primary hover:underline"
							>
								{session.environmentId}
							</a>
							<div class="text-muted-foreground">v{session.environmentVersion ?? '—'}</div>
						</CardContent>
					</Card>
				{/if}

				{#if session.vaultIds.length > 0}
					<Card>
						<CardHeader class="pb-2">
							<CardTitle class="text-sm">Vaults</CardTitle>
						</CardHeader>
						<CardContent class="text-xs space-y-1">
							{#each session.vaultIds as vid}
								<a href="/workspaces/{slug}/credentials/{vid}" class="text-primary hover:underline block truncate">
									{vid}
								</a>
							{/each}
						</CardContent>
					</Card>
				{/if}

				<Card>
					<CardHeader class="pb-2">
						<CardTitle class="text-sm flex items-center gap-2">
							<Activity class="size-4" /> Observability
						</CardTitle>
					</CardHeader>
					<CardContent class="text-xs space-y-3">
						<div class="grid grid-cols-2 gap-2">
							<div>
								<div class="text-[10px] uppercase text-muted-foreground">MLflow session</div>
								<code class="block truncate text-[11px]" title={session.mlflowSessionId ?? session.id}>
									{shortMlflowId(mlflowGroup?.mlflowSessionId ?? session.mlflowSessionId ?? session.id)}
								</code>
							</div>
							<div>
								<div class="text-[10px] uppercase text-muted-foreground">Run</div>
								<code class="block truncate text-[11px]" title={session.mlflowRunId ?? ''}>
									{shortMlflowId(session.mlflowRunId)}
								</code>
							</div>
						</div>
						<div class="flex flex-wrap gap-2">
							{#if session.mlflowExperimentId || session.mlflowRunId || mlflowGroup?.sessionUrl}
								<a
									href={mlflowGroup?.sessionUrl ??
										`/api/observability/mlflow/sessions/${encodeURIComponent(session.id)}`}
									target="_blank"
									rel="noreferrer"
									class="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-primary hover:bg-accent"
									title="Open MLflow chat session"
								>
									Session <ExternalLink class="size-3" />
								</a>
							{/if}
							{#if session.mlflowRunId}
								<a
									href={mlflowGroup?.runUrl ??
										`/api/observability/mlflow/sessions/${encodeURIComponent(session.id)}?target=run`}
									target="_blank"
									rel="noreferrer"
									class="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-primary hover:bg-accent"
									title="Open MLflow run"
								>
									Run <ExternalLink class="size-3" />
								</a>
							{/if}
							<a
								href={`/observability?sessionId=${encodeURIComponent(session.id)}`}
								class="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
								title="Open local trace console"
							>
								Local traces
							</a>
						</div>
					</CardContent>
				</Card>

				<Card>
					<CardHeader class="pb-2">
						<CardTitle class="text-sm flex items-center gap-2">
							<Settings class="size-4" /> Active Runtime
							{#if runtimeConfig?.data?.source}
								<Badge variant="outline" class="ml-auto text-[9px]">
									{runtimeConfig.data.source}
								</Badge>
							{/if}
						</CardTitle>
					</CardHeader>
					<CardContent class="text-xs space-y-3">
						{#if runtimeConfigLoading && !runtimeConfig}
							<div class="space-y-1.5">
								<Skeleton class="h-4" />
								<Skeleton class="h-4" />
								<Skeleton class="h-20" />
							</div>
						{:else if runtimeConfig}
							{@const agentRuntime = runtimeSection('agent')}
							{@const llmRuntime = runtimeSection('llm')}
							{@const toolRuntime = runtimeSection('tools')}
							{@const mcpRuntime = runtimeSection('mcp')}
							{@const mlflowRuntime = runtimeSection('mlflow')}
							{@const daprRuntime = runtimeSection('dapr')}
							<div class="grid grid-cols-2 gap-2">
								<div>
									<div class="text-[10px] uppercase text-muted-foreground">Model</div>
									<code
										class="block truncate text-[11px]"
										title={runtimeText(llmRuntime.providerModel) ??
											runtimeText(llmRuntime.modelSpec) ??
											''}
									>
										{runtimeText(llmRuntime.providerModel) ??
											runtimeText(llmRuntime.modelSpec) ??
											'—'}
									</code>
								</div>
								<div>
									<div class="text-[10px] uppercase text-muted-foreground">Provider</div>
									<code class="block truncate text-[11px]" title={runtimeText(llmRuntime.provider) ?? ''}>
										{runtimeText(llmRuntime.provider) ?? '—'}
									</code>
								</div>
								<div>
									<div class="text-[10px] uppercase text-muted-foreground">Tools</div>
									<code class="block truncate text-[11px]">
										{runtimeCount(toolRuntime, 'toolCount') ??
											runtimeCount(toolRuntime, 'declaredToolCount') ??
											(Array.isArray(toolRuntime.declaredTools)
												? toolRuntime.declaredTools.length
												: '—')}
									</code>
								</div>
								<div>
									<div class="text-[10px] uppercase text-muted-foreground">MCP</div>
									<code class="block truncate text-[11px]">
										{runtimeCount(mcpRuntime, 'serverCount') ?? 0} servers
									</code>
								</div>
								<div>
									<div class="text-[10px] uppercase text-muted-foreground">Skills</div>
									<code class="block truncate text-[11px]">
										{Array.isArray(runtimeConfig.data.skills)
											? runtimeConfig.data.skills.length
											: 0}
									</code>
								</div>
								<div>
									<div class="text-[10px] uppercase text-muted-foreground">Turn</div>
									<code class="block truncate text-[11px]">
										{runtimeConfig.data.turn ?? 0}
									</code>
								</div>
							</div>
							<div class="space-y-1">
								<div class="text-[10px] uppercase text-muted-foreground">Runtime ids</div>
								<code class="block truncate text-[11px]" title={runtimeText(daprRuntime.appId) ?? runtimeText(agentRuntime.appid) ?? ''}>
									{runtimeText(daprRuntime.appId) ?? runtimeText(agentRuntime.appid) ?? '—'}
								</code>
								<code class="block truncate text-[11px]" title={runtimeConfig.data.instanceId ?? ''}>
									{runtimeConfig.data.instanceId ?? '—'}
								</code>
							</div>
							<div class="grid grid-cols-2 gap-2">
								<div>
									<div class="text-[10px] uppercase text-muted-foreground">Config hash</div>
									<code class="block truncate text-[11px]" title={runtimeConfig.data.configHash ?? ''}>
										{runtimeConfig.data.configHash?.slice(0, 12) ?? '—'}
									</code>
								</div>
								<div>
									<div class="text-[10px] uppercase text-muted-foreground">MLflow run</div>
									<code class="block truncate text-[11px]" title={runtimeText(mlflowRuntime.runId) ?? ''}>
										{shortMlflowId(runtimeText(mlflowRuntime.runId))}
									</code>
								</div>
							</div>
							<details class="rounded-md border bg-background/50">
								<summary class="cursor-pointer px-2 py-1.5 text-[11px] text-muted-foreground">
									CloudEvents JSON
								</summary>
								<pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t p-2 text-[10px]">{runtimeConfigJson()}</pre>
							</details>
						{:else}
							<div class="text-muted-foreground">
								No runtime snapshot yet.
								{#if runtimeConfigError}
									<span class="block text-[10px] text-rose-500">{runtimeConfigError}</span>
								{/if}
							</div>
						{/if}
					</CardContent>
				</Card>

				{#if session.workflowExecutionId}
					<Card>
						<CardHeader class="pb-2">
							<CardTitle class="text-sm flex items-center gap-2">
								<Workflow class="size-4" /> Workflow run
							</CardTitle>
						</CardHeader>
						<CardContent class="text-xs space-y-1">
							{#if session.workflowId}
								<a
									href="/workspaces/{slug}/workflows/{session.workflowId}/runs/{session.workflowExecutionId}"
									class="text-primary hover:underline truncate block"
								>
									{session.workflowExecutionId}
								</a>
							{:else}
								<span class="text-muted-foreground truncate block">
									{session.workflowExecutionId}
								</span>
							{/if}
							<div class="text-muted-foreground text-[10px]">
								This session was spawned by a <code>durable/run</code> node in
								a workflow. Click through to see the full DAG.
							</div>
						</CardContent>
					</Card>
				{/if}

					{#if primarySandboxName}
						{@const sbxName = primarySandboxName}
						<Card>
							<CardHeader class="pb-2">
								<div class="flex items-start justify-between gap-2">
									<CardTitle class="text-sm flex items-center gap-2 min-w-0">
										<Container class="size-4 shrink-0" />
										<span class="truncate">{primarySandboxLabel}</span>
										{#if sandboxAlive === 'alive'}
											<Badge
												variant="outline"
												class="text-[9px] gap-1 bg-green-600/15 text-green-700 dark:text-green-400 border-transparent"
											>
												<span class="size-1.5 rounded-full bg-green-500"></span>
												live
											</Badge>
										{:else if sandboxAlive === 'terminated'}
											<Badge variant="outline" class="text-[9px]">terminated</Badge>
										{/if}
									</CardTitle>
									{#if hasDestroyableSessionSandbox}
										<Button
											variant="ghost"
											size="icon"
											class="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
											onclick={destroySessionSandbox}
											disabled={sandboxDeleting || sandboxAlive === 'terminated'}
											title="Destroy sandbox"
											aria-label="Destroy sandbox"
										>
											{#if sandboxDeleting}
												<Loader2 class="size-4 animate-spin" />
											{:else}
												<Trash2 class="size-4" />
											{/if}
										</Button>
									{/if}
								</div>
							</CardHeader>
							<CardContent class="text-xs space-y-1">
								{#if sandboxAlive === 'terminated'}
									<span class="font-mono text-muted-foreground line-through">{sbxName}</span>
									<div class="text-muted-foreground text-[10px]">
										The sandbox has been garbage-collected. Live terminal, files, and logs
										are no longer available for this session.
									</div>
								{:else if session.runtimeSandboxName}
									<div class="font-mono text-muted-foreground break-all">
										{session.runtimeSandboxName}
									</div>
									<div class="text-muted-foreground text-[10px]">
										Per-session runtime host for this interactive session.
									</div>
									{#if session.workspaceSandboxName}
										<div class="text-muted-foreground text-[10px]">
											Workspace:
											<a
												href="/sandboxes/{session.workspaceSandboxName}"
												class="text-primary hover:underline font-mono"
											>
												{session.workspaceSandboxName}
											</a>
										</div>
									{/if}
								{:else if session.workspaceSandboxName}
									<a
										href="/sandboxes/{session.workspaceSandboxName}"
										class="text-primary hover:underline font-mono"
									>
										{session.workspaceSandboxName}
									</a>
									<div class="text-muted-foreground text-[10px]">
										Per-session OpenShell sandbox — open the terminal, browse files,
										and inspect live logs.
									</div>
								{:else if session.sandboxName}
									<a
										href="/sandboxes/{session.sandboxName}"
										class="text-primary hover:underline font-mono"
									>
										{session.sandboxName}
									</a>
									<div class="text-muted-foreground text-[10px]">
										Runtime pod — this session ran on the shared {session.sandboxName} agent deployment.
									</div>
								{/if}
								{#if sandboxDeleteError}
									<div class="text-destructive text-[10px]">{sandboxDeleteError}</div>
								{/if}
							</CardContent>
						</Card>
					{/if}

				<SessionResourcesPanel {sessionId} workspaceSlug={slug} />
				<SessionOutputsPanel {sessionId} />
				<SessionCapacityCard {sessionId} workspaceSlug={slug} />

				<Card>
					<CardHeader class="pb-2">
						<CardTitle class="text-sm">Usage</CardTitle>
					</CardHeader>
					<CardContent class="text-xs text-muted-foreground space-y-0.5">
						<div>Input: {session.usage?.input_tokens ?? 0}</div>
						<div>Output: {session.usage?.output_tokens ?? 0}</div>
						<div>Cache read: {session.usage?.cache_read_input_tokens ?? 0}</div>
						<div>Cache creation: {session.usage?.cache_creation_input_tokens ?? 0}</div>
					</CardContent>
				</Card>

				<Card>
					<CardHeader class="pb-2">
						<CardTitle class="text-sm">Status</CardTitle>
					</CardHeader>
					<CardContent class="text-xs space-y-1.5">
						<div class="font-mono">{session.status}</div>
						{#if session.stopReason}
							<StopReasonChip stopReason={session.stopReason} />
						{/if}
						<div class="text-muted-foreground">
							<Clock class="inline size-3" />
							{new Date(session.updatedAt).toLocaleString()}
						</div>
					</CardContent>
				</Card>
			{/if}
		</aside>
	</div>
</div>

{#if baseAgentForDrawer && session}
	<SessionConfigDrawer
		bind:open={forkDrawerOpen}
		baseAgent={baseAgentForDrawer}
		mode="fork"
		sessionId={session.id}
		fromSequence={events[events.length - 1]?.sequence ?? 1}
		workspaceSlug={slug}
		projectId={session.projectId ?? null}
	/>
{/if}
