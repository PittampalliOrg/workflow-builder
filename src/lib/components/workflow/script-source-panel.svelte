<script lang="ts">
	import { onMount } from 'svelte';
	import { EditorView, lineNumbers, keymap, highlightActiveLine, highlightActiveLineGutter, Decoration, type DecorationSet } from '@codemirror/view';
	import { EditorState, StateEffect, StateField, Compartment } from '@codemirror/state';
	import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
	import { javascript } from '@codemirror/lang-javascript';
	import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
	import { oneDark } from '@codemirror/theme-one-dark';

	interface Props {
		value: string;
		readonly?: boolean;
		dark?: boolean;
		onChange?: (next: string) => void;
		/** Fires with the 1-based line the cursor lands on (code→canvas sync). */
		onCursorLine?: (line: number) => void;
		/** Save shortcut (Cmd/Ctrl+S) forwarded to the workspace. */
		onSave?: () => void;
	}
	let {
		value,
		readonly = false,
		dark = true,
		onChange = undefined,
		onCursorLine = undefined,
		onSave = undefined
	}: Props = $props();

	let host: HTMLDivElement;
	let view: EditorView | null = null;
	/** Guards the value→editor sync from echoing the editor's own edits. */
	let selfEdit = false;

	// ── Flash highlight (canvas→code sync) ────────────────────────────────────
	const setFlash = StateEffect.define<{ from: number; to: number } | null>();
	const flashField = StateField.define<DecorationSet>({
		create: () => Decoration.none,
		update(deco, tr) {
			deco = deco.map(tr.changes);
			for (const e of tr.effects) {
				if (e.is(setFlash)) {
					deco = e.value
						? Decoration.set([
								Decoration.line({ class: 'cm-wfb-flash' }).range(e.value.from)
							])
						: Decoration.none;
				}
			}
			return deco;
		},
		provide: (f) => EditorView.decorations.from(f)
	});
	let flashTimer: ReturnType<typeof setTimeout> | null = null;

	/** Scroll the editor to a 1-based line and flash-highlight it. */
	export function revealLine(line: number) {
		if (!view) return;
		const doc = view.state.doc;
		const ln = Math.max(1, Math.min(line, doc.lines));
		const info = doc.line(ln);
		view.dispatch({
			effects: [
				setFlash.of({ from: info.from, to: info.to }),
				EditorView.scrollIntoView(info.from, { y: 'center' })
			],
			selection: { anchor: info.from }
		});
		view.focus();
		if (flashTimer) clearTimeout(flashTimer);
		flashTimer = setTimeout(() => view?.dispatch({ effects: setFlash.of(null) }), 1600);
	}

	const themeCompartment = new Compartment();
	const readonlyCompartment = new Compartment();

	const baseTheme = EditorView.theme({
		'&': { height: '100%', fontSize: '12.5px' },
		'.cm-scroller': {
			fontFamily: "'Geist Mono', ui-monospace, SFMono-Regular, monospace",
			lineHeight: '1.6'
		},
		'.cm-gutters': { border: 'none', background: 'transparent' },
		'.cm-wfb-flash': {
			backgroundColor: 'color-mix(in oklch, oklch(0.72 0.2 328) 22%, transparent)',
			transition: 'background-color 0.6s ease'
		},
		'&.cm-focused': { outline: 'none' }
	});

	const lightTheme = [syntaxHighlighting(defaultHighlightStyle)];

	function themeFor(isDark: boolean) {
		return isDark ? [oneDark] : lightTheme;
	}

	onMount(() => {
		view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: value,
				extensions: [
					lineNumbers(),
					history(),
					bracketMatching(),
					highlightActiveLine(),
					highlightActiveLineGutter(),
					javascript(),
					flashField,
					baseTheme,
					themeCompartment.of(themeFor(dark)),
					readonlyCompartment.of(EditorState.readOnly.of(readonly)),
					keymap.of([
						{
							key: 'Mod-s',
							run: () => {
								onSave?.();
								return true;
							}
						},
						indentWithTab,
						...defaultKeymap,
						...historyKeymap
					]),
					EditorView.updateListener.of((update) => {
						if (update.docChanged && onChange) {
							selfEdit = true;
							onChange(update.state.doc.toString());
							queueMicrotask(() => (selfEdit = false));
						}
						if (update.selectionSet && onCursorLine) {
							const head = update.state.selection.main.head;
							onCursorLine(update.state.doc.lineAt(head).number);
						}
					})
				]
			})
		});
		return () => {
			view?.destroy();
			view = null;
		};
	});

	// External value replacement (e.g. the AI assistant saved a new script) —
	// only when it differs and the change didn't originate here.
	$effect(() => {
		const next = value;
		if (!view || selfEdit) return;
		const current = view.state.doc.toString();
		if (next !== current) {
			view.dispatch({ changes: { from: 0, to: current.length, insert: next } });
		}
	});

	$effect(() => {
		view?.dispatch({ effects: themeCompartment.reconfigure(themeFor(dark)) });
	});
	$effect(() => {
		view?.dispatch({
			effects: readonlyCompartment.reconfigure(EditorState.readOnly.of(readonly))
		});
	});
</script>

<div bind:this={host} class="h-full w-full overflow-hidden"></div>
