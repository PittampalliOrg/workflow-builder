<script lang="ts">
	/**
	 * The Code tab for dynamic-script workflows — THE single code surface
	 * (replaces the SW "Spec" editor for scripts and the old floating split
	 * pane). Edits flow through the store's shared draft so the canvas
	 * re-projects as you type; canvas node clicks arrive as reveal requests.
	 */
	import { getContext } from 'svelte';
	import { CircleCheck, CircleAlert, LoaderCircle, Save, FileCode2 } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import type { createUiStore } from '$lib/stores/ui.svelte';
	import ScriptSourcePanel from './script-source-panel.svelte';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const ui = getContext<ReturnType<typeof createUiStore> | undefined>('ui');

	const value = $derived(store.scriptDraft ?? store.scriptSource);
	const dark = $derived(ui?.theme !== 'light');

	function onEdit(next: string) {
		store.scriptDraft = next === store.scriptSource ? null : next;
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
		const script = store.scriptDraft ?? store.scriptSource;
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
			if (seq !== validateSeq) return;
			validation = body.ok
				? { state: 'ok', agentCalls: body.estimatedAgentCalls ?? null }
				: { state: 'error', message: body.error ?? 'invalid script' };
		} catch {
			if (seq === validateSeq) validation = { state: 'idle' };
		}
	}

	const errorLine = $derived.by(() => {
		if (validation.state !== 'error') return null;
		const m = validation.message.match(/(?:line|:)\s*(\d+)/i);
		return m ? Number(m[1]) : null;
	});

	// ── Save ───────────────────────────────────────────────────────────────────
	let saving = $state(false);
	async function save() {
		if (!store.scriptDirty || saving) return;
		saving = true;
		try {
			const res = await fetch(`/api/workflows/${store.workflowId}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					spec: {
						...(store.spec ?? {}),
						engine: 'dynamic-script',
						script: store.scriptDraft
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
			store.scriptDraft = null;
			toast.success('Script saved');
		} finally {
			saving = false;
		}
	}

	// ── Canvas→code jumps ──────────────────────────────────────────────────────
	let sourcePanel = $state<ReturnType<typeof ScriptSourcePanel> | null>(null);
	let lastRevealNonce = $state(0);
	$effect(() => {
		const req = store.scriptRevealRequest;
		if (!req || req.nonce === lastRevealNonce) return;
		lastRevealNonce = req.nonce;
		requestAnimationFrame(() => sourcePanel?.revealLine(req.line));
	});
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5">
		<FileCode2 class="size-3.5 text-muted-foreground" />
		<span class="text-[11px] font-medium text-foreground/80">
			{store.workflowName || 'script'}
			{#if store.scriptDirty}<span class="ml-1 text-fuchsia-400" title="Unsaved changes">●</span>{/if}
		</span>
		<div class="ml-auto flex items-center gap-2">
			{#if validation.state === 'checking'}
				<span class="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground">
					<LoaderCircle class="size-3 animate-spin" /> checking
				</span>
			{:else if validation.state === 'ok'}
				<span
					class="inline-flex items-center gap-1 text-[10.5px] text-emerald-500 dark:text-emerald-300"
					title="Validated by the script evaluator"
				>
					<CircleCheck class="size-3" /> valid
				</span>
			{:else if validation.state === 'error'}
				<button
					class="inline-flex max-w-[200px] items-center gap-1 text-[10.5px] text-red-500 dark:text-red-300"
					title={validation.message}
					onclick={() => errorLine != null && sourcePanel?.revealLine(errorLine)}
				>
					<CircleAlert class="size-3 shrink-0" />
					<span class="truncate">{validation.message}</span>
				</button>
			{/if}
			{#if store.scriptDirty}
				<button
					class="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[10.5px] font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60"
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
		</div>
	</div>
	<div class="min-h-0 flex-1">
		<ScriptSourcePanel
			bind:this={sourcePanel}
			{value}
			{dark}
			onChange={onEdit}
			onCursorLine={(l) => (store.scriptCursorLine = l)}
			onSave={save}
		/>
	</div>
</div>
