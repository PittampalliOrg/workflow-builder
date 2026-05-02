<script lang="ts">
	import { onMount } from 'svelte';

	interface Props {
		value: string;
		onChange: (next: string) => void;
		placeholder?: string;
		minHeight?: string;
		readonly?: boolean;
		/**
		 * `plain` (default): no language extension — best for free-form prompt text.
		 * `yaml`: load @codemirror/lang-yaml — also acceptable for JSON since YAML is
		 *        a strict superset of JSON syntax (string/array/object/number tokens
		 *        all highlight correctly).
		 */
		language?: 'plain' | 'yaml';
	}

	let {
		value,
		onChange,
		placeholder: placeholderText = '',
		minHeight = '60vh',
		readonly = false,
		language = 'plain'
	}: Props = $props();

	let container: HTMLDivElement;
	// CodeMirror's EditorView/EditorState — lazy-imported, so the bundle only
	// pulls them on pages that mount this component.
	let editorView: { dispatch: (tr: unknown) => void; state: { doc: { toString(): string; length: number } }; destroy: () => void } | null = null;
	let isInternalUpdate = false;

	onMount(() => {
		initEditor();
		return () => {
			editorView?.destroy();
			editorView = null;
		};
	});

	// External value changes flow into the editor state. Guard against the
	// listener-fired echo so the parent's onChange doesn't loop.
	$effect(() => {
		const v = value;
		if (!editorView) return;
		const current = editorView.state.doc.toString();
		if (v === current) return;
		isInternalUpdate = true;
		editorView.dispatch({
			changes: { from: 0, to: editorView.state.doc.length, insert: v }
		});
		isInternalUpdate = false;
	});

	async function initEditor() {
		const {
			EditorView,
			keymap,
			lineNumbers,
			highlightActiveLineGutter,
			highlightActiveLine,
			drawSelection,
			placeholder
		} = await import('@codemirror/view');
		const { EditorState } = await import('@codemirror/state');
		const { oneDark } = await import('@codemirror/theme-one-dark');
		const { defaultKeymap, history, historyKeymap, indentWithTab } = await import(
			'@codemirror/commands'
		);
		const { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, indentOnInput } = await import(
			'@codemirror/language'
		);
		const { closeBrackets } = await import('@codemirror/autocomplete');

		const updateListener = EditorView.updateListener.of((update) => {
			if (isInternalUpdate || !update.docChanged) return;
			onChange(update.state.doc.toString());
		});

		const langExtensions: unknown[] = [];
		if (language === 'yaml') {
			const { yaml } = await import('@codemirror/lang-yaml');
			langExtensions.push(yaml());
			langExtensions.push(foldGutter());
			langExtensions.push(indentOnInput());
			langExtensions.push(closeBrackets());
		}

		const extensions = [
			lineNumbers(),
			highlightActiveLineGutter(),
			history(),
			drawSelection(),
			highlightActiveLine(),
			bracketMatching(),
			syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
			EditorView.lineWrapping,
			EditorState.allowMultipleSelections.of(true),
			keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
			...langExtensions,
			oneDark,
			EditorState.readOnly.of(readonly),
			placeholder(placeholderText),
			updateListener,
			EditorView.theme({
				'&': {
					fontSize: '13px',
					height: '100%'
				},
				'.cm-scroller': {
					overflow: 'auto',
					fontFamily:
						'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
				},
				'.cm-content': {
					padding: '12px 0',
					lineHeight: '1.55'
				},
				'.cm-gutters': {
					backgroundColor: 'transparent',
					border: 'none'
				}
			})
		];

		editorView = new EditorView({
			doc: value,
			parent: container,
			extensions: extensions as never
		}) as unknown as typeof editorView;
	}
</script>

<div
	bind:this={container}
	class="overflow-hidden rounded-md border bg-[#282c34]"
	style="min-height: {minHeight}; height: {minHeight};"
></div>
