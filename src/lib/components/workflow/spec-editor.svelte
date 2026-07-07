<script lang="ts">
	/**
	 * Live spec editor with syntax highlighting via CodeMirror 6.
	 *
	 * SW 1.0 workflows edit the spec as YAML; dynamic-script workflows edit
	 * the JS script directly (the script IS the spec) with JavaScript
	 * highlighting — edits re-render the canvas structure preview live.
	 * Canvas/AI changes are reflected back into the editor.
	 */
	import { onMount, getContext } from 'svelte';
	import { Copy, Wand2, Check } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { toast } from 'svelte-sonner';
	import yaml from 'js-yaml';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import type { createUiStore } from '$lib/stores/ui.svelte';
	import { applySpec } from '$lib/helpers/ai-spec-applier';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const ui = getContext<ReturnType<typeof createUiStore>>('ui');

	let editorContainer: HTMLDivElement;
	let editorView: any = null;
	let isInternalUpdate = false;
	let lastAppliedYaml = '';
	let saved = $state(true);
	let applyTimeout: ReturnType<typeof setTimeout> | null = null;

	// Dynamic-script: the JS source IS the spec; edit it directly.
	const isScript = $derived(store.isDynamicScript);

	// Convert current spec to YAML string
	function specToYaml(): string {
		if (!store.spec) return '';
		try {
			return yaml.dump(store.spec, { lineWidth: 120, noRefs: true });
		} catch {
			return '';
		}
	}

	function currentDocSource(): string {
		return isScript ? store.scriptSource : specToYaml();
	}

	// Initialize CodeMirror when tab first becomes visible
	let editorInitialized = false;
	onMount(() => {
		return () => {
			if (applyTimeout) clearTimeout(applyTimeout);
			editorView?.destroy();
		};
	});

	$effect(() => {
		if (ui.rightPanelTab === 'code' && !editorInitialized && editorContainer) {
			editorInitialized = true;
			// Small delay to ensure the tab content is rendered with dimensions
			requestAnimationFrame(() => initEditor());
		}
	});

	// The language extension is chosen at init, but the workflow (and thus
	// isDynamicScript) loads async — if the mode flips after init (e.g. the
	// Spec tab was already active during load), rebuild the editor in the
	// right language.
	let initializedMode = $state<boolean | null>(null);
	$effect(() => {
		const mode = isScript;
		if (!editorInitialized || !editorView || initializedMode === mode) return;
		editorView.destroy();
		editorView = null;
		requestAnimationFrame(() => initEditor());
	});

	async function initEditor() {
		const { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, highlightActiveLine } = await import('@codemirror/view');
		const { EditorState } = await import('@codemirror/state');
		const { yaml: yamlLang } = await import('@codemirror/lang-yaml');
		const { javascript } = await import('@codemirror/lang-javascript');
		const { oneDark } = await import('@codemirror/theme-one-dark');
		const { defaultKeymap, history, historyKeymap, indentWithTab } = await import('@codemirror/commands');
		const { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, indentOnInput } = await import('@codemirror/language');
		const { closeBrackets } = await import('@codemirror/autocomplete');

		initializedMode = isScript;
		const initialYaml = currentDocSource();
		lastAppliedYaml = initialYaml;

		const updateListener = EditorView.updateListener.of((update) => {
			if (isInternalUpdate) return;
			if (update.docChanged) {
				saved = false;
				// Debounce: apply spec after 800ms of no typing
				if (applyTimeout) clearTimeout(applyTimeout);
				applyTimeout = setTimeout(() => applyEditorToCanvas(), 800);
			}
		});

		// Dark theme that matches the app
		const appTheme = EditorView.theme({
			'&': {
				backgroundColor: 'transparent',
				fontSize: '12px',
				height: '100%',
			},
			'.cm-content': {
				fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
				padding: '8px 0',
			},
			'.cm-gutters': {
				backgroundColor: 'transparent',
				borderRight: '1px solid hsl(var(--border))',
				color: 'hsl(var(--muted-foreground))',
			},
			'.cm-activeLineGutter': {
				backgroundColor: 'hsl(var(--accent) / 0.3)',
			},
			'.cm-activeLine': {
				backgroundColor: 'hsl(var(--accent) / 0.1)',
			},
			'.cm-cursor': {
				borderLeftColor: 'hsl(var(--foreground))',
			},
			'.cm-selectionBackground': {
				backgroundColor: 'hsl(var(--accent) / 0.3) !important',
			},
			'&.cm-focused .cm-selectionBackground': {
				backgroundColor: 'hsl(var(--accent) / 0.4) !important',
			},
			'.cm-scroller': {
				overflow: 'auto',
			},
		});

		editorView = new EditorView({
			parent: editorContainer,
			state: EditorState.create({
				doc: initialYaml,
				extensions: [
					lineNumbers(),
					highlightActiveLineGutter(),
					highlightSpecialChars(),
					history(),
					foldGutter(),
					drawSelection(),
					indentOnInput(),
					bracketMatching(),
					closeBrackets(),
					highlightActiveLine(),
					isScript ? javascript() : yamlLang(),
					oneDark,
					appTheme,
					syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
					keymap.of([
						...defaultKeymap,
						...historyKeymap,
						indentWithTab,
						{ key: 'Mod-s', run: () => { applyEditorToCanvas(); return true; } },
					]),
					updateListener,
					EditorView.lineWrapping,
				],
			}),
		});

	}

	// Refresh editor dimensions when Spec tab becomes active (CM needs visible container)
	$effect(() => {
		if (ui.rightPanelTab === 'code' && editorView) {
			// requestAnimationFrame ensures the tab content is rendered
			requestAnimationFrame(() => {
				editorView.requestMeasure();
			});
		}
	});

	// Watch for external spec changes (from AI agent, canvas edits, etc.)
	$effect(() => {
		const currentYaml = currentDocSource();
		if (!editorView || currentYaml === lastAppliedYaml) return;

		// External change — update editor content
		isInternalUpdate = true;
		const currentDoc = editorView.state.doc.toString();
		if (currentDoc !== currentYaml) {
			editorView.dispatch({
				changes: { from: 0, to: currentDoc.length, insert: currentYaml },
			});
			lastAppliedYaml = currentYaml;
			saved = true;
		}
		isInternalUpdate = false;
	});

	async function applyEditorToCanvas() {
		if (!editorView) return;
		if (isScript) {
			await applyScriptToStore();
			return;
		}
		await applyYamlToCanvas();
	}

	async function applyScriptToStore() {
		const text = editorView.state.doc.toString();
		if (text === lastAppliedYaml) { saved = true; return; }
		if (!text.trim()) {
			toast.error('Script is empty');
			return;
		}
		// The script IS the spec — update spec.script in place; the ScriptCanvas
		// re-parses the structure preview from store.scriptSource. Validation of
		// the dialect happens server-side (validate_workflow_script) / at run.
		await store.applySpecAndRebuild({ ...(store.spec ?? {}), engine: 'dynamic-script', script: text });
		lastAppliedYaml = text;
		saved = true;
	}

	async function applyYamlToCanvas() {
		if (!editorView) return;
		const yamlText = editorView.state.doc.toString();
		if (yamlText === lastAppliedYaml) { saved = true; return; }

		try {
			const parsed = yaml.load(yamlText) as Record<string, unknown>;
			if (!parsed || typeof parsed !== 'object') {
				toast.error('Invalid YAML');
				return;
			}
			// Must have document key to be a valid spec
			if (!parsed.document) {
				toast.error('Missing "document" section in spec');
				return;
			}

			const result = await applySpec(store, parsed);
			lastAppliedYaml = yamlText;
			saved = true;

			if (!result.success) {
				toast.error('Spec errors: ' + result.errors.join(', '));
			}
		} catch (e) {
			// YAML parse error — don't apply, show error
			const msg = e instanceof Error ? e.message : 'YAML parse error';
			// Don't toast on every keystroke — only on explicit save
		}
	}

	function handleCopy() {
		if (!editorView) return;
		navigator.clipboard.writeText(editorView.state.doc.toString());
		toast.success(isScript ? 'Script copied to clipboard' : 'YAML copied to clipboard');
	}

	function handleFormat() {
		if (!editorView) return;
		try {
			const parsed = yaml.load(editorView.state.doc.toString());
			const formatted = yaml.dump(parsed, { lineWidth: 120, noRefs: true });
			isInternalUpdate = true;
			editorView.dispatch({
				changes: { from: 0, to: editorView.state.doc.length, insert: formatted },
			});
			isInternalUpdate = false;
			toast.success('YAML formatted');
		} catch {
			toast.error('Cannot format — invalid YAML');
		}
	}
</script>

<div class="flex h-full flex-col" style="min-height: 0;">
	<!-- Editor -->
	<div class="flex-1 overflow-hidden" style="min-height: 0;" bind:this={editorContainer}></div>

	<!-- Footer toolbar -->
	<div class="flex items-center justify-between border-t border-border px-2 py-1">
		<div class="flex items-center gap-1">
			{#if !isScript}
				<Button variant="ghost" size="sm" class="h-6 text-[10px] px-2 gap-1" onclick={handleFormat}>
					<Wand2 size={10} />
					Format
				</Button>
			{/if}
			<Button variant="ghost" size="sm" class="h-6 text-[10px] px-2 gap-1" onclick={handleCopy}>
				<Copy size={10} />
				Copy
			</Button>
		</div>
		<div class="flex items-center gap-1 text-[10px] text-muted-foreground">
			<span class="mr-2 opacity-60">{isScript ? 'JavaScript · dynamic-script' : 'YAML · SW 1.0'}</span>
			{#if saved}
				<Check size={10} class="text-green-500" />
				<span>Saved</span>
			{:else}
				<span class="text-amber-500">Unsaved</span>
			{/if}
		</div>
	</div>
</div>
