<script lang="ts">
	import { getContext } from 'svelte';
	import {
		LayoutPanelLeft,
		Workflow as WorkflowIcon,
		Code2,
		CircleCheck,
		CircleAlert,
		LoaderCircle,
		Save
	} from '@lucide/svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import type { createUiStore } from '$lib/stores/ui.svelte';
	import { toast } from 'svelte-sonner';
	import ScriptCanvas from './script-canvas.svelte';
	import ScriptSourcePanel from './script-source-panel.svelte';

	/**
	 * The code-first authoring surface: the SCRIPT is the workflow, the canvas
	 * is its live projection. Three views (Canvas · Split · Code) over one
	 * draft, with bidirectional sync — click a node to jump to its source line,
	 * move the cursor to light up its node — plus save + as-you-type
	 * evaluator-truth validation.
	 */

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const ui = getContext<ReturnType<typeof createUiStore> | undefined>('ui');

	type ViewMode = 'canvas' | 'split' | 'code';
	let view = $state<ViewMode>('canvas');

	// ── Draft state ────────────────────────────────────────────────────────────
	// The draft follows the SAVED source until the user edits; external saves
	// (the AI assistant, another tab) flow through unless the draft is dirty.
	let draft = $state('');
	let dirty = $state(false);
	let savedSource = $derived(store.scriptSource);
	$effect(() => {
		const saved = savedSource;
		if (!dirty) draft = saved;
	});

	function onEdit(next: string) {
		draft = next;
		dirty = next !== savedSource;
		scheduleValidate();
	}

	// ── Live validation (evaluator-truth, debounced) ──────────────────────────
	type Validation =
		| { state: 'idle' }
		| { state: 'checking' }
		| { state: 'ok'; agentCalls: number | null }
		| { state: 'error'; message: string };
	let validation = $state<Validation>({ state: 'idle' });
	let validateTimer: ReturnType<typeof setTimeout> | null = null;
	let validateSeq = 0;

	function scheduleValidate() {
		if (validateTimer) clearTimeout(validateTimer);
		validateTimer = setTimeout(runValidate, 600);
	}
	async function runValidate() {
		const seq = ++validateSeq;
		const script = draft;
		if (!script.trim()) return;
		validation = { state: 'checking' };
		try {
			const res = await fetch('/api/workflows/validate-script', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ script })
			});
			const body = (await res.json()) as {
				ok: boolean;
				error?: string;
				estimatedAgentCalls?: number | null;
			};
			if (seq !== validateSeq) return; // stale response
			validation = body.ok
				? { state: 'ok', agentCalls: body.estimatedAgentCalls ?? null }
				: { state: 'error', message: body.error ?? 'invalid script' };
		} catch {
			if (seq === validateSeq) validation = { state: 'idle' };
		}
	}

	/** Best-effort line number out of an evaluator error message. */
	const errorLine = $derived.by(() => {
		if (validation.state !== 'error') return null;
		const m = validation.message.match(/(?:line|:)\s*(\d+)/i);
		return m ? Number(m[1]) : null;
	});

	// ── Save ───────────────────────────────────────────────────────────────────
	let saving = $state(false);
	async function save() {
		if (!dirty || saving) return;
		saving = true;
		try {
			const res = await fetch(`/api/workflows/${store.workflowId}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					spec: {
						...(store.spec ?? {}),
						engine: 'dynamic-script',
						script: draft
					}
				})
			});
			if (!res.ok) {
				const text = await res.text().catch(() => '');
				toast.error('Save failed', { description: text.slice(0, 300) });
				return;
			}
			const updated = (await res.json()) as { spec?: Record<string, unknown> };
			if (updated?.spec) store.spec = updated.spec;
			dirty = false;
			toast.success('Script saved', { description: 'The canvas reflects the new structure.' });
		} finally {
			saving = false;
		}
	}

	// ── Bidirectional sync ─────────────────────────────────────────────────────
	let sourcePanel = $state<ReturnType<typeof ScriptSourcePanel> | null>(null);
	let cursorLine = $state<number | null>(null);

	function onNodeLine(line: number) {
		if (view === 'canvas') view = 'split';
		// Wait a tick when the editor is just mounting (canvas→split transition).
		requestAnimationFrame(() => sourcePanel?.revealLine(line));
	}

	const dark = $derived(ui?.theme !== 'light');
	const canvasSource = $derived(dirty ? draft : null);
</script>

<div class="relative flex h-full w-full flex-col">
	<!-- View toggle + status strip -->
	<div class="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center">
		<div class="pointer-events-auto flex items-center gap-1 rounded-full border border-border/60 bg-background/85 p-1 shadow-md backdrop-blur">
			{#each [
				{ id: 'canvas', label: 'Canvas', Icon: WorkflowIcon },
				{ id: 'split', label: 'Split', Icon: LayoutPanelLeft },
				{ id: 'code', label: 'Code', Icon: Code2 }
			] as opt (opt.id)}
				<button
					class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition
						{view === opt.id
						? 'bg-fuchsia-500/15 text-fuchsia-300 ring-1 ring-fuchsia-400/40'
						: 'text-muted-foreground hover:bg-muted hover:text-foreground'}"
					onclick={() => (view = opt.id as ViewMode)}
				>
					<opt.Icon class="size-3.5" />
					{opt.label}
				</button>
			{/each}

			{#if view !== 'canvas'}
				<span class="mx-1 h-4 w-px bg-border/70"></span>
				{#if validation.state === 'checking'}
					<span class="inline-flex items-center gap-1 pr-2 text-[11px] text-muted-foreground">
						<LoaderCircle class="size-3 animate-spin" /> checking
					</span>
				{:else if validation.state === 'ok'}
					<span class="inline-flex items-center gap-1 pr-2 text-[11px] text-emerald-300" title="Validated by the script evaluator">
						<CircleCheck class="size-3" /> valid
					</span>
				{:else if validation.state === 'error'}
					<button
						class="inline-flex max-w-[280px] items-center gap-1 pr-2 text-[11px] text-red-300"
						title={validation.message}
						onclick={() => errorLine != null && sourcePanel?.revealLine(errorLine)}
					>
						<CircleAlert class="size-3 shrink-0" />
						<span class="truncate">{validation.message}</span>
					</button>
				{/if}
				{#if dirty}
					<button
						class="inline-flex items-center gap-1 rounded-full bg-fuchsia-500/90 px-2.5 py-1 text-[11px] font-semibold text-white shadow hover:bg-fuchsia-500 disabled:opacity-60"
						onclick={save}
						disabled={saving}
						title="Save (⌘S)"
					>
						{#if saving}
							<LoaderCircle class="size-3 animate-spin" />
						{:else}
							<Save class="size-3" />
						{/if}
						Save
					</button>
				{/if}
			{/if}
		</div>
	</div>

	<div class="flex min-h-0 flex-1">
		{#if view !== 'code'}
			<div class="min-w-0 {view === 'split' ? 'flex-1 border-r border-border/60' : 'w-full'}">
				<ScriptCanvas
					scriptSource={canvasSource}
					activeLine={view === 'split' ? cursorLine : null}
					{onNodeLine}
				/>
			</div>
		{/if}
		{#if view !== 'canvas'}
			<div class="min-w-0 bg-background/50 {view === 'split' ? 'flex-1' : 'w-full'} pt-14">
				<ScriptSourcePanel
					bind:this={sourcePanel}
					value={dirty ? draft : savedSource}
					{dark}
					onChange={onEdit}
					onCursorLine={(l) => (cursorLine = l)}
					onSave={save}
				/>
			</div>
		{/if}
	</div>
</div>
