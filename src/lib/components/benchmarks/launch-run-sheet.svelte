<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as Sheet from '$lib/components/ui/sheet';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Activity, AlertTriangle, Bot, Check, Gauge, Grid3x3, Loader2, Plus, Rocket, Search, Trash2, Users } from '@lucide/svelte';
	import type { RunnableAgent, SuiteFacet } from '$lib/types/benchmark-instance';

	type CapacityDiagnostics = {
		storedEffectiveConcurrency: number;
		blockedBy: string[];
		resources: Array<{
			resourceType: string;
			active: number;
			limit: number;
			headroom: number;
			staleActive: number;
		}>;
		runtime: {
			replicas: number | null;
			slotsPerReplica: number | null;
			slots: number | null;
		};
		daprWorkflow: {
			effectiveCapacity: number | null;
		};
		parentWorkflow: {
			replicas: number | null;
			readyReplicas: number | null;
			connectedWorkers: number | null;
			effectiveWorkflowCapacity: number | null;
			daprRuntimeVersion: string | null;
			schedulerReadyPods: number | null;
			schedulerPods: number | null;
			recentActorErrorCount: number | null;
			recentReminderErrorCount: number | null;
			daprRuntimePressure: boolean;
		};
		sandbox: {
			schedulableSandboxCapacity: number | null;
			ephemeralStorageLimitedCapacity: number | null;
			nodeFsLimitedCapacity: number | null;
			kueueClusterQueueName?: string | null;
			kueueAvailableSandboxSlots?: number | null;
			kueueCpuLimitedCapacity?: number | null;
			kueueMemoryLimitedCapacity?: number | null;
			kueueEphemeralStorageLimitedCapacity?: number | null;
			kueuePodLimitedCapacity?: number | null;
			diskPressureNodeCount: number | null;
		};
		workflowLifecycle?: {
			sharedActorStateStore: boolean | null;
			issue: string | null;
			error: string | null;
			parentActorStateStore: {
				componentName: string;
				tablePrefix: string | null;
			} | null;
			childActorStateStore: {
				componentName: string;
				tablePrefix: string | null;
			} | null;
		};
	};

	type Props = {
		open: boolean;
		instanceIds: string[];
		suiteSlug: string;
		runnableAgents: RunnableAgent[];
		suiteFacets: SuiteFacet[];
		onOpenChange: (next: boolean) => void;
		/** Optional pre-fill (used by compare-page "Re-run" affordance). */
		defaults?: {
			agentId?: string;
			modelNameOrPath?: string;
			modelConfigLabel?: string;
			tags?: string[];
		} | null;
		requirePrevalidatedEnvironments?: boolean;
	};

	let {
		open = $bindable(false),
		instanceIds,
		suiteSlug,
		runnableAgents,
		suiteFacets,
		onOpenChange,
		defaults = null,
		requirePrevalidatedEnvironments = false
	}: Props = $props();

	const slug = $derived((page.params.slug as string) ?? 'default');
	const DEFAULT_INFERENCE_CONCURRENCY = 10;
	const DEFAULT_EVALUATION_CONCURRENCY = 24;
	const MAX_INFERENCE_CONCURRENCY = 500;
	const MAX_EVALUATION_CONCURRENCY = 128;
	const DEFAULT_MAX_ACTIVE_INFERENCE = 56;
	const MAX_COMPARISON_AGENTS = 4;

	type LaunchMode = 'single' | 'agent-comparison' | 'matrix';
	let launchMode = $state<LaunchMode>('single');
	let agentId = $state('');
	let comparisonAgentIds = $state<string[]>([]);
	let comparisonLabel = $state('');
	let comparisonLabelTouched = $state(false);
	let modelNameOrPath = $state('');
	let modelConfigLabel = $state('');
	let concurrency = $state(DEFAULT_INFERENCE_CONCURRENCY);
	let evaluationConcurrency = $state(DEFAULT_EVALUATION_CONCURRENCY);
	let timeoutSeconds = $state(7200);
	// Empty input means "use agent default"; the API treats null as "no override".
	let maxTurns = $state<number | null>(null);
	let evaluatorResourceClass = $state<'standard' | 'large' | 'xlarge'>('standard');
	const executionBackend = 'dapr-kueue';
	let executionClass = $state<'benchmark-fast' | 'secure-gvisor'>('benchmark-fast');
	let tagsInput = $state('');
	let agentQuery = $state('');
	let capacityDiagnostics = $state<CapacityDiagnostics | null>(null);
	let capacityLoading = $state(false);
	let capacityFetchSeq = 0;

	// Matrix mode: each arm becomes its own benchmark_runs row sharing the
	// same instanceIds + campaign tag, but with per-arm agent/model/maxTurns/
	// label so the compare page can light up the differing axis.
	type MatrixArm = {
		id: string;
		agentId: string;
		modelNameOrPath: string;
		maxTurns: number | null;
		modelConfigLabel: string;
		// True once the user has typed into this arm's label field. Auto-label
		// stops rewriting it from that point so we don't stomp manual edits.
		labelTouched: boolean;
	};
	let arms = $state<MatrixArm[]>([]);
	let armAgentQuery = $state<Record<string, string>>({});

	let submitting = $state(false);
	let errorMessage = $state<string | null>(null);

	const selectedAgent = $derived(runnableAgents.find((a) => a.id === agentId) ?? null);
	const selectedComparisonAgents = $derived(
		comparisonAgentIds
			.map((id) => runnableAgents.find((a) => a.id === id))
			.filter((agent): agent is RunnableAgent => Boolean(agent))
	);
	const capacityAgentId = $derived(
		launchMode === 'matrix'
			? (arms[0]?.agentId ?? agentId)
			: launchMode === 'agent-comparison'
				? (comparisonAgentIds[0] ?? agentId)
				: agentId
	);
	const capacityAgent = $derived(runnableAgents.find((a) => a.id === capacityAgentId) ?? null);
	const visibleAgents = $derived.by(() => {
		const query = agentQuery.trim().toLowerCase();
		if (!query) return runnableAgents;
		return runnableAgents.filter((agent) =>
			[agent.name, agent.slug, agent.modelSpec ?? ''].some((value) =>
				value.toLowerCase().includes(query)
			)
		);
	});
	const selectedCapacity = $derived(capacityAgent?.benchmarkCapacity ?? null);
	const maxActiveInference = $derived(
		Math.max(1, selectedCapacity?.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_INFERENCE)
	);
	const effectiveInferenceConcurrency = $derived(
		Math.max(1, Math.min(instanceIds.length || 1, concurrency, maxActiveInference))
	);
	const maxSafeConcurrency = $derived(
		Math.max(0, capacityDiagnostics?.storedEffectiveConcurrency ?? effectiveInferenceConcurrency)
	);
	const inferenceConcurrencyCapped = $derived(
		instanceIds.length > 0 && effectiveInferenceConcurrency < instanceIds.length
	);

	// When the sheet opens with `defaults` (e.g. fork from compare page),
	// pre-fill the form. Reset whenever `defaults` changes between opens.
	$effect(() => {
		if (open && defaults) {
			if (defaults.agentId) agentId = defaults.agentId;
			if (defaults.modelNameOrPath) modelNameOrPath = defaults.modelNameOrPath;
			if (defaults.modelConfigLabel != null) modelConfigLabel = defaults.modelConfigLabel;
			if (Array.isArray(defaults.tags)) tagsInput = defaults.tags.join(', ');
		}
	});

	// When the sheet opens, default agent + model from the first runnable agent
	// (only if the user hasn't already chosen one).
	$effect(() => {
		if (open && !agentId && runnableAgents.length > 0) {
			selectAgent(runnableAgents[0]);
		}
	});

	$effect(() => {
		if (selectedAgent && !modelNameOrPath) {
			modelNameOrPath = parseModelDefault(selectedAgent.modelSpec);
		}
	});

	$effect(() => {
		if (open && launchMode === 'agent-comparison' && comparisonAgentIds.length === 0 && agentId) {
			comparisonAgentIds = [agentId];
		}
	});

	$effect(() => {
		if (open && launchMode === 'matrix' && arms.length === 0 && runnableAgents.length > 0) {
			// Seed the matrix with two arms by default — one arm isn't a
			// comparison, and the submit gate requires ≥2 anyway.
			arms = [createArm(runnableAgents[0]), createArm(runnableAgents[0])];
		}
	});

	// Auto-label arms whose labels haven't been hand-edited. Walks all arms,
	// rewrites only those where the computed label differs from the current
	// value AND `labelTouched` is false. The equality guard prevents an
	// infinite effect loop.
	$effect(() => {
		if (launchMode !== 'matrix' || arms.length === 0) return;
		let changed = false;
		const next = arms.map((arm, idx) => {
			if (arm.labelTouched) return arm;
			const auto = autoLabelFor(arm, idx);
			if (arm.modelConfigLabel === auto) return arm;
			changed = true;
			return { ...arm, modelConfigLabel: auto };
		});
		if (changed) arms = next;
	});

	$effect(() => {
		// Auto-fill the campaign label whenever the comparison/matrix mode
		// becomes active. Re-fires on `launchMode` changes so switching from
		// agent-comparison → matrix updates the suffix (and vice-versa). The
		// equality guard prevents an infinite re-trigger loop.
		if (!open || comparisonLabelTouched) return;
		if (launchMode !== 'agent-comparison' && launchMode !== 'matrix') return;
		const expected = defaultComparisonLabel();
		if (comparisonLabel !== expected) comparisonLabel = expected;
	});

	$effect(() => {
		if (!open || !capacityAgentId || instanceIds.length === 0) {
			capacityDiagnostics = null;
			capacityLoading = false;
			return;
		}
		const seq = ++capacityFetchSeq;
		const controller = new AbortController();
		const timer = setTimeout(async () => {
			capacityLoading = true;
			try {
				const res = await fetch('/api/benchmarks/capacity', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					signal: controller.signal,
					body: JSON.stringify({
						agentId: capacityAgentId,
						instanceIds,
						requestedConcurrency: MAX_INFERENCE_CONCURRENCY,
						evaluationConcurrency,
						modelNameOrPath: modelNameOrPath.trim() || undefined,
						modelConfigLabel: modelConfigLabel.trim() || undefined,
						executionBackend
					})
				});
				const body = (await res.json().catch(() => ({}))) as {
					diagnostics?: CapacityDiagnostics;
				};
				if (seq === capacityFetchSeq && res.ok) {
					capacityDiagnostics = body.diagnostics ?? null;
				}
			} catch (err) {
				if (!(err instanceof DOMException && err.name === 'AbortError')) {
					if (seq === capacityFetchSeq) capacityDiagnostics = null;
				}
			} finally {
				if (seq === capacityFetchSeq) capacityLoading = false;
			}
		}, 150);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	});

	function parseModelDefault(modelSpec: string | null): string {
		if (!modelSpec) return '';
		// Common shapes: "anthropic:claude-opus-4-7", "claude-opus-4-7", "openai:gpt-4"
		const colonIdx = modelSpec.indexOf(':');
		return colonIdx >= 0 ? modelSpec.slice(colonIdx + 1) : modelSpec;
	}

	function selectAgent(agent: RunnableAgent) {
		agentId = agent.id;
		modelNameOrPath = parseModelDefault(agent.modelSpec);
		if (launchMode === 'agent-comparison' && comparisonAgentIds.length === 0) {
			comparisonAgentIds = [agent.id];
		}
	}

	function setLaunchMode(next: LaunchMode) {
		launchMode = next;
		if (next === 'agent-comparison' && comparisonAgentIds.length === 0 && agentId) {
			comparisonAgentIds = [agentId];
		}
		if (next === 'matrix' && arms.length === 0 && runnableAgents.length > 0) {
			arms = [createArm(runnableAgents[0]), createArm(runnableAgents[0])];
		}
	}

	function useMaxSafeConcurrency() {
		if (maxSafeConcurrency > 0) {
			concurrency = Math.min(MAX_INFERENCE_CONCURRENCY, maxSafeConcurrency);
		}
	}

	function suiteName(slug: string): string {
		return suiteFacets.find((s) => s.slug === slug)?.name ?? slug;
	}

	const previewIds = $derived(instanceIds.slice(0, 3));
	const remainingCount = $derived(Math.max(0, instanceIds.length - previewIds.length));
	const comparisonTag = $derived(normalizeTag(comparisonLabel) || defaultComparisonLabel());

	const estimatedMinutes = $derived(() => {
		// Rough wall-clock estimate. Assumes ~7 minutes per instance with bounded
		// concurrency. Real runs vary widely; this is a rough prior so the user
		// has a sense of magnitude before submitting.
		if (instanceIds.length === 0 || effectiveInferenceConcurrency <= 0) return 0;
		const perInstanceMinutes = 7;
		return Math.ceil((instanceIds.length / effectiveInferenceConcurrency) * perInstanceMinutes);
	});

	function formatEstimate(mins: number): string {
		if (mins <= 0) return '—';
		if (mins < 60) return `~${mins}m`;
		const hours = Math.floor(mins / 60);
		const remainingMin = mins % 60;
		return remainingMin === 0 ? `~${hours}h` : `~${hours}h ${remainingMin}m`;
	}


	function parseTags(input: string): string[] {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const raw of input.split(/[,\s]+/)) {
			const tag = raw.trim().toLowerCase();
			if (!tag || seen.has(tag)) continue;
			seen.add(tag);
			out.push(tag);
		}
		return out;
	}

	function normalizeTag(input: string): string {
		return input
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9_.-]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 64);
	}

	function defaultComparisonLabel(): string {
		const date = new Date().toISOString().slice(0, 10);
		const suite = normalizeTag(suiteSlug) || 'swebench';
		const kind = launchMode === 'matrix' ? 'matrix' : 'agent-comparison';
		return `${suite}-${kind}-${date}`.slice(0, 64);
	}

	function toggleComparisonAgent(agent: RunnableAgent) {
		if (comparisonAgentIds.includes(agent.id)) {
			comparisonAgentIds = comparisonAgentIds.filter((id) => id !== agent.id);
			return;
		}
		if (comparisonAgentIds.length >= MAX_COMPARISON_AGENTS) return;
		comparisonAgentIds = [...comparisonAgentIds, agent.id];
		if (!agentId) selectAgent(agent);
	}

	// --- Matrix mode helpers --------------------------------------------------

	function newArmId(): string {
		// Browser-native; no extra dependency. 8 chars is enough for keying.
		return crypto.randomUUID().slice(0, 8);
	}

	function createArm(agent?: RunnableAgent): MatrixArm {
		return {
			id: newArmId(),
			agentId: agent?.id ?? '',
			modelNameOrPath: agent ? parseModelDefault(agent.modelSpec) : '',
			maxTurns: null,
			modelConfigLabel: '',
			labelTouched: false
		};
	}

	function addArm() {
		if (arms.length >= MAX_COMPARISON_AGENTS) return;
		const seed = runnableAgents[0];
		arms = [...arms, createArm(seed)];
	}

	function removeArm(armId: string) {
		if (arms.length <= 1) return;
		arms = arms.filter((a) => a.id !== armId);
	}

	function setArmAgent(armId: string, agent: RunnableAgent) {
		arms = arms.map((a) =>
			a.id === armId
				? {
						...a,
						agentId: agent.id,
						// Auto-fill model from the picked agent's spec ONLY if the
						// user hasn't typed their own override; otherwise keep it.
						modelNameOrPath: a.modelNameOrPath.trim()
							? a.modelNameOrPath
							: parseModelDefault(agent.modelSpec)
					}
				: a
		);
	}

	function updateArm<K extends keyof MatrixArm>(armId: string, key: K, value: MatrixArm[K]) {
		arms = arms.map((a) => (a.id === armId ? { ...a, [key]: value } : a));
	}

	function handleArmLabelInput(armId: string, value: string) {
		// Clearing the field re-engages auto-label so the user can recover
		// without remounting the sheet.
		const touched = value.trim().length > 0;
		arms = arms.map((a) =>
			a.id === armId ? { ...a, modelConfigLabel: value, labelTouched: touched } : a
		);
	}

	function handleArmMaxTurnsInput(armId: string, value: string) {
		const trimmed = value.trim();
		if (!trimmed) {
			updateArm(armId, 'maxTurns', null);
			return;
		}
		const parsed = Number.parseInt(trimmed, 10);
		if (!Number.isFinite(parsed) || parsed < 1) return;
		updateArm(armId, 'maxTurns', parsed);
	}

	function shortAgentSlug(armAgentId: string): string {
		const ag = runnableAgents.find((a) => a.id === armAgentId);
		return (ag?.slug ?? ag?.name ?? 'agent').slice(0, 12);
	}

	function autoLabelFor(arm: MatrixArm, idx: number): string {
		// Look across all arms to decide which axes vary, then build the
		// label from the first 1-2 differing axes. Single-arm fall-through
		// uses `arm<idx>` so labels remain unique by position.
		const agentVaries = new Set(arms.map((a) => a.agentId)).size > 1;
		const modelVaries =
			new Set(arms.map((a) => a.modelNameOrPath.trim() || 'auto')).size > 1;
		const maxTurnsVaries =
			new Set(arms.map((a) => (a.maxTurns ?? 'default').toString())).size > 1;

		const parts: string[] = [];
		if (agentVaries) parts.push(shortAgentSlug(arm.agentId));
		if (modelVaries) {
			const m = (arm.modelNameOrPath.trim() || 'auto').slice(0, 16);
			parts.push(m);
		}
		if (maxTurnsVaries) {
			parts.push(arm.maxTurns == null ? 'mtdefault' : `mt${arm.maxTurns}`);
		}
		if (parts.length === 0) parts.push(`arm${idx + 1}`);
		return normalizeTag(parts.slice(0, 2).join('-')) || `arm${idx + 1}`;
	}

	// Fingerprint each arm so we can block submit when two arms would create
	// indistinguishable benchmark runs (same agent + model + maxTurns + label).
	const armFingerprints = $derived(
		arms.map(
			(a) =>
				`${a.agentId}|${a.modelNameOrPath.trim().toLowerCase()}|${a.maxTurns ?? 'default'}|${a.modelConfigLabel.trim().toLowerCase()}`
		)
	);
	const hasDuplicateArms = $derived(
		arms.length >= 2 && new Set(armFingerprints).size < armFingerprints.length
	);
	const matrixSubmitReady = $derived(
		arms.length >= 2 &&
			!hasDuplicateArms &&
			arms.every((a) => a.agentId && a.modelConfigLabel.trim().length > 0)
	);

	function runTags(extraTags: string[] = []): string[] {
		return [...new Set([...parseTags(tagsInput), ...extraTags, 'dapr-kueue'])];
	}

	function reset() {
		errorMessage = null;
		modelConfigLabel = '';
		tagsInput = '';
		agentQuery = '';
		// keep agent + model for repeat launches
	}

	async function submit() {
		if (instanceIds.length === 0 || submitting) return;
		if (launchMode === 'single' && !agentId) return;
		if (launchMode === 'agent-comparison' && selectedComparisonAgents.length < 2) return;
		if (launchMode === 'matrix' && !matrixSubmitReady) return;
		submitting = true;
		errorMessage = null;
		try {
			if (launchMode === 'agent-comparison') {
				const createdRunIds: string[] = [];
				const failures: string[] = [];
				const campaignTag = comparisonTag;
				const sharedTags = runTags([campaignTag, 'agent-comparison']);
				for (const agent of selectedComparisonAgents) {
					const res = await fetch('/api/benchmarks/runs', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							suiteSlug,
							agentId: agent.id,
							instanceIds,
							modelNameOrPath: parseModelDefault(agent.modelSpec) || undefined,
							modelConfigLabel: modelConfigLabel.trim() || campaignTag,
							concurrency,
							evaluationConcurrency,
							timeoutSeconds,
							maxTurns,
							evaluatorResourceClass,
							tags: sharedTags,
							requirePrevalidatedEnvironments,
							executionBackend,
							executionClass
						})
					});
					const body = await res.json().catch(() => ({}) as Record<string, unknown>);
					if (!res.ok) {
						failures.push(
							`${agent.name}: ${
								(body as { message?: string; error?: string }).message ??
								(body as { error?: string }).error ??
								`failed (${res.status})`
							}`
						);
						continue;
					}
					const run = (body as { run?: { id: string } }).run;
					const coordinatorStartError = (body as { coordinatorStartError?: string | null })
						.coordinatorStartError;
					if (coordinatorStartError) {
						failures.push(`${agent.name}: coordinator failed to start: ${coordinatorStartError}`);
					}
					if (run?.id) createdRunIds.push(run.id);
				}
				if (failures.length > 0 && createdRunIds.length < 2) {
					throw new Error(failures.join('; '));
				}
				if (createdRunIds.length >= 2) {
					onOpenChange(false);
					reset();
					await goto(
						`/workspaces/${slug}/benchmarks/compare?runs=${createdRunIds
							.map((id) => encodeURIComponent(id))
							.join(',')}&tag=${encodeURIComponent(campaignTag)}`
					);
					return;
				}
				if (createdRunIds.length === 1) {
					onOpenChange(false);
					reset();
					await goto(`/workspaces/${slug}/benchmarks/runs/${encodeURIComponent(createdRunIds[0])}`);
					return;
				}
				throw new Error('No comparison runs were created');
			}

			if (launchMode === 'matrix') {
				// Matrix mode: each arm becomes its own benchmark_runs row sharing
				// the same instanceIds + campaign tag, but with per-arm agent /
				// model / maxTurns / label so the compare page can light up the
				// differing axis automatically via buildAxisDiff.
				const createdRunIds: string[] = [];
				const failures: string[] = [];
				const campaignTag = comparisonTag;
				const sharedTags = runTags([campaignTag, 'matrix-comparison']);
				for (const arm of arms) {
					const agent = runnableAgents.find((a) => a.id === arm.agentId);
					if (!agent) {
						failures.push(`arm ${arm.id}: agent not found`);
						continue;
					}
					const res = await fetch('/api/benchmarks/runs', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							suiteSlug,
							agentId: arm.agentId,
							instanceIds,
							modelNameOrPath:
								arm.modelNameOrPath.trim() ||
								parseModelDefault(agent.modelSpec) ||
								undefined,
							modelConfigLabel: arm.modelConfigLabel.trim() || campaignTag,
							maxTurns: arm.maxTurns,
							concurrency,
							evaluationConcurrency,
							timeoutSeconds,
							evaluatorResourceClass,
							tags: sharedTags,
							requirePrevalidatedEnvironments,
							executionBackend,
							executionClass
						})
					});
					const body = await res.json().catch(() => ({}) as Record<string, unknown>);
					const label = arm.modelConfigLabel.trim() || agent.name;
					if (!res.ok) {
						failures.push(
							`${label}: ${
								(body as { message?: string; error?: string }).message ??
								(body as { error?: string }).error ??
								`failed (${res.status})`
							}`
						);
						continue;
					}
					const run = (body as { run?: { id: string } }).run;
					const coordinatorStartError = (body as { coordinatorStartError?: string | null })
						.coordinatorStartError;
					if (coordinatorStartError) {
						failures.push(`${label}: coordinator failed to start: ${coordinatorStartError}`);
					}
					if (run?.id) createdRunIds.push(run.id);
				}
				if (failures.length > 0 && createdRunIds.length < 2) {
					throw new Error(failures.join('; '));
				}
				if (createdRunIds.length >= 2) {
					onOpenChange(false);
					reset();
					await goto(
						`/workspaces/${slug}/benchmarks/compare?runs=${createdRunIds
							.map((id) => encodeURIComponent(id))
							.join(',')}&tag=${encodeURIComponent(campaignTag)}`
					);
					return;
				}
				if (createdRunIds.length === 1) {
					onOpenChange(false);
					reset();
					await goto(`/workspaces/${slug}/benchmarks/runs/${encodeURIComponent(createdRunIds[0])}`);
					return;
				}
				throw new Error('No matrix runs were created');
			}

			const res = await fetch('/api/benchmarks/runs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					suiteSlug,
					agentId,
					instanceIds,
					modelNameOrPath: modelNameOrPath.trim() || undefined,
					modelConfigLabel: modelConfigLabel.trim() || undefined,
					concurrency,
					evaluationConcurrency,
					timeoutSeconds,
					maxTurns,
					evaluatorResourceClass,
					tags: runTags(),
					requirePrevalidatedEnvironments,
					executionBackend,
					executionClass
				})
			});
			const body = await res.json().catch(() => ({}) as Record<string, unknown>);
			if (!res.ok) {
				throw new Error(
					(body as { message?: string; error?: string }).message ??
						(body as { error?: string }).error ??
						`Failed to start run (${res.status})`
				);
			}
			const run = (body as { run?: { id: string } }).run;
			const coordinatorStartError = (body as { coordinatorStartError?: string | null })
				.coordinatorStartError;
			if (coordinatorStartError) {
				errorMessage = `Run was created but the coordinator failed to start: ${coordinatorStartError}`;
				return;
			}
			if (run?.id) {
				onOpenChange(false);
				reset();
				await goto(`/workspaces/${slug}/benchmarks/runs/${encodeURIComponent(run.id)}`);
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			submitting = false;
		}
	}
</script>

<Sheet.Root
	{open}
	onOpenChange={(next) => {
		onOpenChange(next);
		if (!next) reset();
	}}
>
	<Sheet.Content side="right" class="w-full sm:max-w-lg flex min-h-0 flex-col">
		<Sheet.Header class="space-y-1">
			<Sheet.Title class="flex items-center gap-2">
				<Rocket class="size-4" /> Launch benchmark run
			</Sheet.Title>
			<Sheet.Description>
				Dispatch selected instances through the SWE-bench coordinator as one run or as a
				shared comparison campaign across agents.
			</Sheet.Description>
		</Sheet.Header>

		<div class="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-3">
			<div class="grid grid-cols-3 gap-2">
				<Button
					type="button"
					variant={launchMode === 'single' ? 'default' : 'outline'}
					class="justify-start"
					onclick={() => setLaunchMode('single')}
				>
					<Rocket class="size-3.5" />
					Single run
				</Button>
				<Button
					type="button"
					variant={launchMode === 'agent-comparison' ? 'default' : 'outline'}
					class="justify-start"
					onclick={() => setLaunchMode('agent-comparison')}
				>
					<Users class="size-3.5" />
					Compare agents
				</Button>
				<Button
					type="button"
					variant={launchMode === 'matrix' ? 'default' : 'outline'}
					class="justify-start"
					onclick={() => setLaunchMode('matrix')}
				>
					<Grid3x3 class="size-3.5" />
					Matrix
				</Button>
			</div>

			<!-- Target summary -->
			<div class="rounded-md border border-border bg-muted/30 p-3 space-y-2">
				<div class="flex items-center justify-between gap-2">
					<div class="flex items-center gap-2">
						<Badge variant="default">{suiteName(suiteSlug)}</Badge>
						<span class="text-sm font-medium tabular-nums">
							{instanceIds.length} instances
						</span>
					</div>
					<span class="text-[11px] text-muted-foreground">
						est. wall-clock {formatEstimate(estimatedMinutes())}
					</span>
				</div>
				<div class="flex flex-wrap gap-1">
					{#each previewIds as id (id)}
						<Badge variant="outline" class="font-mono text-[10px]">{id}</Badge>
					{/each}
					{#if remainingCount > 0}
						<Badge variant="outline" class="text-[10px]">+{remainingCount} more</Badge>
					{/if}
				</div>
				{#if inferenceConcurrencyCapped}
					<div class="rounded border border-border bg-background/70 px-2 py-1 text-[11px] text-muted-foreground">
						Effective active inference concurrency:
						<span class="font-mono text-foreground">{effectiveInferenceConcurrency}</span>
						{#if selectedCapacity}
							<span>
								· active cap {selectedCapacity.maxActiveSessions}
								· {selectedCapacity.runtimeClass} pool
								({selectedCapacity.runtimeReplicas}×{selectedCapacity.perSidecarWorkflowLimit} per-sidecar Dapr workflow slots)
							</span>
							{#if selectedCapacity.maxActiveSandboxes}
								<span>· sandbox cap {selectedCapacity.maxActiveSandboxes}</span>
							{/if}
						{/if}
					</div>
				{/if}
			</div>

			{#if launchMode !== 'matrix'}
			<!-- Agent -->
			<div class="space-y-1.5">
				<Label for="launch-agent">{launchMode === 'agent-comparison' ? 'Agents' : 'Agent'}</Label>
				{#if runnableAgents.length === 0}
					<Alert variant="destructive">
						<AlertDescription>
							No registered <code class="text-[11px]">dapr-agent-py</code> agents in this workspace.
							or <code class="text-[11px]">adk-agent-py</code> agents in this workspace. Publish an agent first.
						</AlertDescription>
					</Alert>
				{:else}
					{#if launchMode === 'agent-comparison'}
						<div class="space-y-1.5">
							<Label for="launch-comparison-label" class="text-xs">Comparison campaign</Label>
							<Input
								id="launch-comparison-label"
								value={comparisonLabel}
								oninput={(event) => {
									comparisonLabelTouched = true;
									comparisonLabel = (event.currentTarget as HTMLInputElement).value;
								}}
								placeholder={defaultComparisonLabel()}
							/>
							<div class="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
								<span>MLflow tag</span>
								<Badge variant="secondary" class="font-mono text-[10px]">#{comparisonTag}</Badge>
								<span>applied to every parent, instance, and eval run</span>
							</div>
						</div>
					{/if}
					<div class="relative">
						<Search class="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
						<Input
							id="launch-agent"
							bind:value={agentQuery}
							placeholder="Search agents…"
							class="h-9 pl-8"
						/>
					</div>
					<div class="max-h-64 min-h-24 overflow-y-auto overscroll-contain rounded-md border border-border bg-background">
						{#if visibleAgents.length === 0}
							<div class="px-3 py-6 text-center text-xs text-muted-foreground">
								No matching agents
							</div>
						{:else}
							{#each visibleAgents as agent (agent.id)}
								{@const comparisonSelected = comparisonAgentIds.includes(agent.id)}
								{@const selected = launchMode === 'agent-comparison' ? comparisonSelected : agent.id === agentId}
								<button
									type="button"
									class={[
										'flex w-full items-center gap-2 border-b border-border/70 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
										selected ? 'bg-primary/10' : '',
										launchMode === 'agent-comparison' &&
										!comparisonSelected &&
										comparisonAgentIds.length >= MAX_COMPARISON_AGENTS
											? 'opacity-60'
											: ''
									].join(' ')}
									aria-pressed={selected}
									onclick={() =>
										launchMode === 'agent-comparison'
											? toggleComparisonAgent(agent)
											: selectAgent(agent)}
								>
									<span class="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
										<Bot class="size-3.5" />
									</span>
									<span class="min-w-0 flex-1">
										<span class="block truncate font-medium">{agent.name}</span>
										<span class="block truncate text-[11px] text-muted-foreground">
											{agent.runtime} · v{agent.currentVersion}{agent.modelSpec ? ` · ${agent.modelSpec}` : ''}
										</span>
									</span>
									{#if selected}
										<Check class="size-4 shrink-0 text-primary" />
									{/if}
								</button>
							{/each}
						{/if}
						</div>
						{#if launchMode === 'agent-comparison'}
							<p class="text-[10px] text-muted-foreground">
								Choose 2-{MAX_COMPARISON_AGENTS} agents. Each agent gets its own benchmark
								parent run with the same instances and campaign tag, then opens the compare view.
							</p>
							{#if selectedComparisonAgents.length > 0}
								<div class="flex flex-wrap gap-1">
									{#each selectedComparisonAgents as agent (agent.id)}
										<Badge variant="outline" class="gap-1 text-[10px]">
											{agent.slug}
											<button
												type="button"
												class="rounded px-0.5 hover:bg-muted"
												aria-label="Remove {agent.name}"
												onclick={() => toggleComparisonAgent(agent)}
											>
												×
											</button>
										</Badge>
									{/each}
								</div>
							{/if}
						{/if}
					{/if}
			</div>
			{/if}

			<!-- Matrix arms -->
			{#if launchMode === 'matrix'}
				<div class="space-y-3">
					<div class="space-y-1.5">
						<Label for="launch-matrix-campaign" class="text-xs">Comparison campaign</Label>
						<Input
							id="launch-matrix-campaign"
							value={comparisonLabel}
							oninput={(event) => {
								comparisonLabelTouched = true;
								comparisonLabel = (event.currentTarget as HTMLInputElement).value;
							}}
							placeholder={defaultComparisonLabel()}
						/>
						<div class="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
							<span>MLflow tag</span>
							<Badge variant="secondary" class="font-mono text-[10px]">#{comparisonTag}</Badge>
							<span>applied to every parent, instance, and eval run</span>
						</div>
					</div>

					{#if runnableAgents.length === 0}
						<Alert variant="destructive">
							<AlertDescription>
								No registered <code class="text-[11px]">dapr-agent-py</code> or
								<code class="text-[11px]">adk-agent-py</code> agents in this workspace. Publish one
								to launch a matrix.
							</AlertDescription>
						</Alert>
					{:else}
						<div class="flex items-center justify-between">
							<Label class="text-xs">Arms ({arms.length}/{MAX_COMPARISON_AGENTS})</Label>
							<span class="text-[10px] text-muted-foreground">
								Varies: agent · model · maxTurns · label
							</span>
						</div>

						<div class="space-y-2">
							{#each arms as arm, idx (arm.id)}
								{@const armAgent = runnableAgents.find((a) => a.id === arm.agentId) ?? null}
								<div class="rounded-md border border-border bg-muted/20 p-3 space-y-2">
									<div class="flex items-center justify-between">
										<Badge variant="default" class="text-[10px]">Arm #{idx + 1}</Badge>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											class="h-6 px-2 text-[10px]"
											onclick={() => removeArm(arm.id)}
											disabled={arms.length <= 1}
											aria-label="Remove this arm"
										>
											<Trash2 class="size-3" />
											Remove
										</Button>
									</div>

									<div class="space-y-1">
										<Label class="text-[11px]" for="arm-{arm.id}-agent">Agent</Label>
										<select
											id="arm-{arm.id}-agent"
											class="w-full h-9 rounded-md border border-border bg-background px-3 text-sm"
											value={arm.agentId}
											onchange={(event) => {
												const target = event.currentTarget as HTMLSelectElement;
												const next = runnableAgents.find((a) => a.id === target.value);
												if (next) setArmAgent(arm.id, next);
											}}
										>
											<option value="" disabled>Pick an agent…</option>
											{#each runnableAgents as ag (ag.id)}
												<option value={ag.id}>
													{ag.name} · v{ag.currentVersion}{ag.modelSpec
														? ` · ${ag.modelSpec}`
														: ''}
												</option>
											{/each}
										</select>
									</div>

									<div class="grid grid-cols-2 gap-2">
										<div class="space-y-1">
											<Label class="text-[11px]" for="arm-{arm.id}-model">Model</Label>
											<Input
												id="arm-{arm.id}-model"
												value={arm.modelNameOrPath}
												oninput={(event) =>
													updateArm(
														arm.id,
														'modelNameOrPath',
														(event.currentTarget as HTMLInputElement).value
													)}
												placeholder={armAgent?.modelSpec
													? parseModelDefault(armAgent.modelSpec)
													: 'auto'}
											/>
										</div>
										<div class="space-y-1">
											<Label class="text-[11px]" for="arm-{arm.id}-maxturns">Max turns</Label>
											<Input
												id="arm-{arm.id}-maxturns"
												type="number"
												min="1"
												max="1000"
												value={arm.maxTurns ?? ''}
												oninput={(event) =>
													handleArmMaxTurnsInput(
														arm.id,
														(event.currentTarget as HTMLInputElement).value
													)}
												placeholder="default"
											/>
										</div>
									</div>

									<div class="space-y-1">
										<Label class="text-[11px]" for="arm-{arm.id}-label">Label</Label>
										<Input
											id="arm-{arm.id}-label"
											value={arm.modelConfigLabel}
											oninput={(event) =>
												handleArmLabelInput(
													arm.id,
													(event.currentTarget as HTMLInputElement).value
												)}
											placeholder={autoLabelFor(arm, idx)}
										/>
										{#if !arm.labelTouched}
											<p class="text-[9px] text-muted-foreground">
												Auto-derived from differing fields. Type to override; clear to re-engage.
											</p>
										{/if}
									</div>
								</div>
							{/each}

							<Button
								type="button"
								variant="outline"
								size="sm"
								class="w-full"
								onclick={addArm}
								disabled={arms.length >= MAX_COMPARISON_AGENTS}
							>
								<Plus class="size-3.5" />
								Add arm
							</Button>
						</div>

						{#if hasDuplicateArms}
							<Alert variant="destructive">
								<AlertTriangle class="size-3.5" />
								<AlertDescription>
									Two or more arms have identical (agent, model, max turns, label). Differentiate
									at least one field per arm before launching.
								</AlertDescription>
							</Alert>
						{/if}

						<p class="text-[10px] text-muted-foreground">
							Each arm becomes its own benchmark run sharing the same instances + campaign tag.
							Capacity estimate below uses arm #1 — other arms may differ.
						</p>
					{/if}
				</div>
			{/if}

			<!-- Model name / path -->
			{#if launchMode === 'single'}
				<div class="space-y-1.5">
					<Label for="launch-model">Model name or path</Label>
					<Input
						id="launch-model"
						bind:value={modelNameOrPath}
						placeholder={selectedAgent?.modelSpec ? parseModelDefault(selectedAgent.modelSpec) : 'auto'}
					/>
					<p class="text-[10px] text-muted-foreground">
						Surfaces in <code>predictions.jsonl</code> as <code>model_name_or_path</code>.
					</p>
				</div>
			{/if}

			<!-- Model config label (label is per-arm in matrix mode, so hide here) -->
			{#if launchMode !== 'matrix'}
				<div class="space-y-1.5">
					<Label for="launch-label">Model config label <span class="text-muted-foreground text-[11px]">(optional)</span></Label>
					<Input
						id="launch-label"
						bind:value={modelConfigLabel}
						placeholder={launchMode === 'agent-comparison' ? comparisonTag : 'e.g. v1-mcp-toggle, no-skills, baseline'}
					/>
					<p class="text-[10px] text-muted-foreground">
						{launchMode === 'agent-comparison'
							? 'Applied consistently across the agent variants so the campaign tag and agent axis stay clear.'
							: 'Used as the comparison axis label when diffing runs. Highly recommended for experiments.'}
					</p>
				</div>
			{/if}

			<!-- Tags -->
			<div class="space-y-1.5">
				<Label for="launch-tags">Tags <span class="text-muted-foreground text-[11px]">(optional)</span></Label>
				<Input
					id="launch-tags"
					bind:value={tagsInput}
					placeholder="experiment-2026-04, mcp-ablation, weekly"
				/>
				{#if parseTags(tagsInput).length > 0}
					<div class="flex flex-wrap gap-1">
						{#each parseTags(tagsInput) as tag (tag)}
							<Badge variant="secondary" class="font-mono text-[10px]">#{tag}</Badge>
						{/each}
					</div>
				{/if}
				{#if launchMode === 'agent-comparison'}
					<div class="flex flex-wrap gap-1">
						<Badge variant="secondary" class="font-mono text-[10px]">#{comparisonTag}</Badge>
						<Badge variant="secondary" class="font-mono text-[10px]">#agent-comparison</Badge>
					</div>
				{/if}
				<p class="text-[10px] text-muted-foreground">
					Comma- or space-separated. Group runs into experiments for one-click comparison via the
					<code class="rounded bg-muted px-1">?tag=</code> filter on the Runs and Compare pages.
				</p>
			</div>

			<!-- Inference concurrency -->
			<div class="space-y-1.5">
				<div class="flex items-center justify-between gap-2">
					<Label for="launch-concurrency">Inference concurrency</Label>
					<Button
						type="button"
						variant="outline"
						size="sm"
						class="h-7 text-xs"
						onclick={useMaxSafeConcurrency}
						disabled={capacityLoading || maxSafeConcurrency <= 0}
						title="Use the current backend capacity estimate"
					>
						<Gauge class="size-3.5" />
						Max safe {capacityLoading ? '…' : maxSafeConcurrency}
					</Button>
				</div>
				<div class="flex items-center gap-3">
					<input
						id="launch-concurrency"
						type="range"
						min="1"
						max={MAX_INFERENCE_CONCURRENCY}
						bind:value={concurrency}
						class="flex-1 accent-primary"
					/>
					<span class="font-mono text-sm tabular-nums w-10 text-right">{concurrency}</span>
				</div>
				<p class="text-[10px] text-muted-foreground">
					Will dispatch up to {effectiveInferenceConcurrency} active
					<code>swebench_instance_workflow</code> children after runtime admission and per-sidecar Dapr workflow caps.
				</p>
				{#if capacityDiagnostics}
					<div class="rounded border border-border bg-background/70 px-2 py-1 text-[10px] text-muted-foreground">
						<span>backend safe {capacityDiagnostics.storedEffectiveConcurrency}</span>
						<span>
							· runtime {capacityDiagnostics.runtime.replicas ?? '—'}×{capacityDiagnostics.runtime.slotsPerReplica ?? '—'}
							= {capacityDiagnostics.runtime.slots ?? '—'} slots
						</span>
						<span>· dapr {capacityDiagnostics.daprWorkflow.effectiveCapacity ?? '—'}</span>
						<span>
							· parent {capacityDiagnostics.parentWorkflow.replicas ?? '—'}×
							{capacityDiagnostics.parentWorkflow.connectedWorkers ?? '—'} workers =
							{capacityDiagnostics.parentWorkflow.effectiveWorkflowCapacity ?? '—'}
						</span>
						{#if capacityDiagnostics.parentWorkflow.daprRuntimeVersion}
							<span>· dapr {capacityDiagnostics.parentWorkflow.daprRuntimeVersion}</span>
						{/if}
						{#if capacityDiagnostics.parentWorkflow.schedulerPods !== null}
							<span>
								· scheduler {capacityDiagnostics.parentWorkflow.schedulerReadyPods ?? '—'}/{capacityDiagnostics.parentWorkflow.schedulerPods}
							</span>
						{/if}
						<span>· sandbox headroom {capacityDiagnostics.sandbox.schedulableSandboxCapacity ?? '—'}</span>
						{#if capacityDiagnostics.sandbox.ephemeralStorageLimitedCapacity !== null}
							<span>· storage {capacityDiagnostics.sandbox.ephemeralStorageLimitedCapacity}</span>
						{/if}
						{#if capacityDiagnostics.sandbox.nodeFsLimitedCapacity !== null}
							<span>· node fs {capacityDiagnostics.sandbox.nodeFsLimitedCapacity}</span>
						{/if}
						{#if capacityDiagnostics.sandbox.kueueAvailableSandboxSlots !== null && capacityDiagnostics.sandbox.kueueAvailableSandboxSlots !== undefined}
							<span>· kueue {capacityDiagnostics.sandbox.kueueAvailableSandboxSlots}</span>
						{/if}
						{#if capacityDiagnostics.sandbox.diskPressureNodeCount}
							<span class="text-amber-600">
								· disk pressure {capacityDiagnostics.sandbox.diskPressureNodeCount}
							</span>
						{/if}
						{#if capacityDiagnostics.blockedBy.length > 0}
							<span class="text-amber-600">
								· blocked by {capacityDiagnostics.blockedBy.map((r) => r.replace(/_/g, ' ')).join(', ')}
							</span>
						{/if}
						{#if capacityDiagnostics.parentWorkflow.daprRuntimePressure}
							<span class="text-amber-600">
								· dapr pressure actor {capacityDiagnostics.parentWorkflow.recentActorErrorCount ?? '—'} reminder {capacityDiagnostics.parentWorkflow.recentReminderErrorCount ?? '—'}
							</span>
						{/if}
						{#if capacityDiagnostics.workflowLifecycle?.issue === 'dapr_actor_state_store_mismatch'}
							<span class="text-amber-600">
								· workflow store mismatch {capacityDiagnostics.workflowLifecycle.parentActorStateStore?.componentName ?? 'parent'} → {capacityDiagnostics.workflowLifecycle.childActorStateStore?.componentName ?? 'child'}
							</span>
						{:else if capacityDiagnostics.workflowLifecycle?.issue && capacityDiagnostics.workflowLifecycle.issue !== 'dapr_component_diagnostics_unavailable'}
							<span class="text-amber-600">
								· workflow lifecycle {capacityDiagnostics.workflowLifecycle.issue.replace(/_/g, ' ')}
							</span>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Evaluation concurrency -->
			<div class="space-y-1.5">
				<Label for="launch-eval-concurrency">Evaluation concurrency</Label>
				<div class="flex items-center gap-3">
					<input
						id="launch-eval-concurrency"
						type="range"
						min="1"
						max={MAX_EVALUATION_CONCURRENCY}
						bind:value={evaluationConcurrency}
						class="flex-1 accent-primary"
					/>
					<span class="font-mono text-sm tabular-nums w-10 text-right">{evaluationConcurrency}</span>
				</div>
				<p class="text-[10px] text-muted-foreground">
					Will keep up to {evaluationConcurrency} Kubernetes-native SWE-bench run-instance TaskRuns active during official grading.
				</p>
			</div>

			<!-- Max turns (single + compare-agents modes; matrix sets it per arm) -->
			{#if launchMode !== 'matrix'}
				<div class="space-y-1.5">
					<Label for="launch-max-turns">
						Max turns <span class="text-muted-foreground text-[11px]">(optional)</span>
					</Label>
					<Input
						id="launch-max-turns"
						type="number"
						min="1"
						max="1000"
						value={maxTurns ?? ''}
						oninput={(event) => {
							const v = (event.currentTarget as HTMLInputElement).value.trim();
							if (!v) {
								maxTurns = null;
								return;
							}
							const parsed = Number.parseInt(v, 10);
							if (Number.isFinite(parsed) && parsed >= 1) maxTurns = parsed;
						}}
						placeholder="agent default"
					/>
					<p class="text-[10px] text-muted-foreground">
						Caps agent reasoning turns per instance. Leave empty to use the agent's published default.
					</p>
				</div>
			{/if}

			<!-- Timeout & resource class -->
			<div class="grid grid-cols-2 gap-3">
				<div class="space-y-1.5">
					<Label for="launch-timeout">Timeout (seconds)</Label>
					<Input
						id="launch-timeout"
						type="number"
						min="60"
						max="86400"
						bind:value={timeoutSeconds}
					/>
				</div>
				<div class="space-y-1.5">
					<Label for="launch-resource">Evaluator resource class</Label>
					<select
						id="launch-resource"
						bind:value={evaluatorResourceClass}
						class="w-full h-9 rounded-md border border-border bg-background px-3 text-sm"
					>
						<option value="standard">Standard</option>
						<option value="large">Large</option>
						<option value="xlarge">XLarge</option>
					</select>
				</div>
			</div>

			<div class="grid grid-cols-2 gap-3">
				<div class="space-y-1.5">
					<Label for="launch-class">Execution class</Label>
					<select
						id="launch-class"
						bind:value={executionClass}
						class="w-full h-9 rounded-md border border-border bg-background px-3 text-sm"
					>
						<option value="benchmark-fast">benchmark-fast</option>
						<option value="secure-gvisor">secure-gvisor</option>
					</select>
				</div>
			</div>

			{#if errorMessage}
				<Alert variant="destructive">
					<AlertDescription>{errorMessage}</AlertDescription>
				</Alert>
			{/if}
		</div>

		<Sheet.Footer class="border-t border-border px-4 py-3 flex flex-row justify-end gap-2">
			<Button variant="outline" onclick={() => onOpenChange(false)} disabled={submitting}>
				Cancel
			</Button>
			<Button
				onclick={submit}
				disabled={submitting ||
					instanceIds.length === 0 ||
					runnableAgents.length === 0 ||
					(launchMode === 'single'
						? !agentId
						: launchMode === 'agent-comparison'
							? selectedComparisonAgents.length < 2
							: !matrixSubmitReady)}
			>
				{#if submitting}
					<Loader2 class="mr-1.5 h-3.5 w-3.5 animate-spin" />
					Starting…
				{:else if launchMode === 'agent-comparison'}
					<Users class="mr-1.5 h-3.5 w-3.5" />
					Start comparison · {selectedComparisonAgents.length} agents × {instanceIds.length} instances
				{:else if launchMode === 'matrix'}
					<Grid3x3 class="mr-1.5 h-3.5 w-3.5" />
					Start campaign · {arms.length} arms × {instanceIds.length} instances
				{:else}
					<Activity class="mr-1.5 h-3.5 w-3.5" />
					Start run · {instanceIds.length} {instanceIds.length === 1 ? 'instance' : 'instances'}
				{/if}
			</Button>
		</Sheet.Footer>
	</Sheet.Content>
</Sheet.Root>
