export type EditorState =
	| 'uninitialized'
	| 'loading'
	| 'idle'
	| 'dragging'
	| 'connecting'
	| 'deleting'
	| 'restoring';

export function createEditorStateMachine() {
	let current = $state<EditorState>('uninitialized');

	// Derived flags based on current state
	let canWriteToStore = $derived(
		current === 'idle' || current === 'dragging' || current === 'connecting' || current === 'deleting'
	);
	let canPushHistory = $derived(current === 'idle' || current === 'dragging');
	let suppressEffect = $derived(current === 'restoring' || current === 'loading');

	function transition(newState: EditorState) {
		current = newState;
	}

	return {
		get current() { return current; },
		get canWriteToStore() { return canWriteToStore; },
		get canPushHistory() { return canPushHistory; },
		get suppressEffect() { return suppressEffect; },
		transition
	};
}
