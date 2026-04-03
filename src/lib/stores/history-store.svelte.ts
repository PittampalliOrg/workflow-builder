const MAX_HISTORY = 50;

export interface HistorySnapshot {
	nodes: unknown[];
	edges: unknown[];
}

export function createHistoryStore() {
	let undoStack = $state<HistorySnapshot[]>([]);
	let redoStack = $state<HistorySnapshot[]>([]);
	let isRestoringFromHistory = $state(false);
	let _transactionDepth = $state(0);
	let _pendingSnapshot = $state<HistorySnapshot | null>(null);

	let canUndo = $derived(undoStack.length > 0);
	let canRedo = $derived(redoStack.length > 0);

	function pushState(snapshot: HistorySnapshot) {
		if (isRestoringFromHistory) return;

		// During a transaction, only capture the first snapshot (the "before" state)
		if (_transactionDepth > 0) {
			if (!_pendingSnapshot) {
				_pendingSnapshot = snapshot;
			}
			return;
		}

		_pushToUndo(snapshot);
	}

	function _pushToUndo(snapshot: HistorySnapshot) {
		undoStack = [...undoStack.slice(-(MAX_HISTORY - 1)), snapshot];
		redoStack = [];
	}

	function startTransaction() {
		_transactionDepth++;
	}

	function commitTransaction() {
		if (_transactionDepth <= 0) return;
		_transactionDepth--;
		if (_transactionDepth === 0 && _pendingSnapshot) {
			_pushToUndo(_pendingSnapshot);
			_pendingSnapshot = null;
		}
	}

	function undo(getCurrent: () => HistorySnapshot): HistorySnapshot | null {
		if (undoStack.length === 0) return null;
		isRestoringFromHistory = true;
		try {
			const entry = undoStack[undoStack.length - 1];
			undoStack = undoStack.slice(0, -1);
			redoStack = [...redoStack, getCurrent()];
			return entry;
		} finally {
			isRestoringFromHistory = false;
		}
	}

	function redo(getCurrent: () => HistorySnapshot): HistorySnapshot | null {
		if (redoStack.length === 0) return null;
		isRestoringFromHistory = true;
		try {
			const entry = redoStack[redoStack.length - 1];
			redoStack = redoStack.slice(0, -1);
			undoStack = [...undoStack, getCurrent()];
			return entry;
		} finally {
			isRestoringFromHistory = false;
		}
	}

	function clear() {
		undoStack = [];
		redoStack = [];
		_transactionDepth = 0;
		_pendingSnapshot = null;
	}

	return {
		get canUndo() { return canUndo; },
		get canRedo() { return canRedo; },
		get isRestoringFromHistory() { return isRestoringFromHistory; },
		pushState,
		startTransaction,
		commitTransaction,
		undo,
		redo,
		clear
	};
}
