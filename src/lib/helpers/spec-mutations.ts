/**
 * Pure spec mutation functions.
 * All take a spec object and return a NEW spec (immutable).
 * The spec YAML is the single source of truth — all UI surfaces
 * (Properties, Spec editor, AI agent, canvas) go through these.
 */

export type Spec = Record<string, unknown>;
export type TaskDef = Record<string, unknown>;
type DoEntry = Record<string, TaskDef>;
type LinearEdge = { source: string; target: string };

function getDoArray(spec: Spec): DoEntry[] {
	return ((spec.do || []) as DoEntry[]);
}

function withDo(spec: Spec, doArray: DoEntry[]): Spec {
	return { ...spec, do: doArray };
}

/** Get all existing task names from the spec's do[] array */
export function getTaskNames(spec: Spec): string[] {
	return getDoArray(spec).map((entry) => Object.keys(entry)[0]).filter(Boolean);
}

/** Find a task definition by name */
export function getTask(spec: Spec, taskName: string): TaskDef | null {
	const entry = getDoArray(spec).find((e) => Object.keys(e)[0] === taskName);
	return entry ? (entry[taskName] as TaskDef) : null;
}

/** Add a new task to the end of the do[] array */
export function addTask(spec: Spec, taskName: string, taskDef: TaskDef): Spec {
	const doArray = [...getDoArray(spec)];
	doArray.push({ [taskName]: taskDef });
	return withDo(spec, doArray);
}

/** Insert a new task after a task name. Use null to insert at the start. */
export function insertTaskAfter(
	spec: Spec,
	taskName: string,
	taskDef: TaskDef,
	afterTaskName?: string | null,
): Spec {
	const doArray = [...getDoArray(spec)];
	const entry = { [taskName]: taskDef };

	if (afterTaskName === null) {
		doArray.unshift(entry);
		return withDo(spec, doArray);
	}

	if (afterTaskName) {
		const idx = doArray.findIndex((candidate) => Object.keys(candidate)[0] === afterTaskName);
		if (idx >= 0) {
			doArray.splice(idx + 1, 0, entry);
			return withDo(spec, doArray);
		}
	}

	doArray.push(entry);
	return withDo(spec, doArray);
}

/** Update an existing task by name. If not found, adds it. */
export function updateTask(spec: Spec, taskName: string, taskDef: TaskDef): Spec {
	const doArray = [...getDoArray(spec)];
	const idx = doArray.findIndex((entry) => Object.keys(entry)[0] === taskName);
	if (idx >= 0) {
		doArray[idx] = { [taskName]: taskDef };
	} else {
		// Task not found — add it (upsert behavior)
		doArray.push({ [taskName]: taskDef });
	}
	return withDo(spec, doArray);
}

/** Remove a task by name */
export function removeTask(spec: Spec, taskName: string): Spec {
	const doArray = getDoArray(spec).filter((entry) => Object.keys(entry)[0] !== taskName);
	return withDo(spec, doArray);
}

/** Rename a task (preserves position in do[] array) */
export function renameTask(spec: Spec, oldName: string, newName: string): Spec {
	const doArray = getDoArray(spec).map((entry) => {
		const key = Object.keys(entry)[0];
		if (key === oldName) {
			return { [newName]: entry[oldName] };
		}
		return entry;
	});
	return withDo(spec, doArray);
}

/** Reorder the do[] array to match the given task name order */
export function reorderTasks(spec: Spec, orderedNames: string[]): Spec {
	const current = getDoArray(spec);
	const byName = new Map(current.map((e) => [Object.keys(e)[0], e]));
	const reordered = orderedNames
		.filter((name) => byName.has(name))
		.map((name) => byName.get(name)!);
	// Append any tasks not in the ordered list (shouldn't happen but safety)
	for (const entry of current) {
		const name = Object.keys(entry)[0];
		if (!orderedNames.includes(name)) {
			reordered.push(entry);
		}
	}
	return withDo(spec, reordered);
}

function taskNameFromGraphId(id: string): string | null {
	if (!id || id === '__start__' || id === '__end__') return null;
	if (id.startsWith('/do/')) {
		const parts = id.split('/');
		return parts[parts.length - 1] || null;
	}
	return id;
}

/**
 * Reorder top-level do[] tasks when edges describe one complete linear path.
 * Returns the original spec if the graph is branching, disconnected, or partial.
 */
export function reorderLinearTasksFromEdges(spec: Spec, edges: LinearEdge[]): Spec {
	const existingNames = getTaskNames(spec);
	if (existingNames.length < 2) return spec;

	const bySource = new Map<string, LinearEdge[]>();
	for (const edge of edges) {
		const list = bySource.get(edge.source) || [];
		list.push(edge);
		bySource.set(edge.source, list);
	}
	if ([...bySource.values()].some((list) => list.length > 1)) return spec;

	const orderedNames: string[] = [];
	const visited = new Set<string>();
	let current = bySource.get('__start__')?.[0]?.target;

	while (current && current !== '__end__' && !visited.has(current)) {
		visited.add(current);
		const taskName = taskNameFromGraphId(current);
		if (!taskName || !existingNames.includes(taskName)) return spec;
		orderedNames.push(taskName);
		current = bySource.get(current)?.[0]?.target;
	}

	if (current !== '__end__') return spec;
	if (orderedNames.length !== existingNames.length) return spec;
	if (orderedNames.some((name, index) => existingNames[index] !== name)) {
		return reorderTasks(spec, orderedNames);
	}
	return spec;
}

/** Update document metadata fields */
export function updateDocument(spec: Spec, fields: Record<string, unknown>): Spec {
	const doc = (spec.document || {}) as Record<string, unknown>;
	return { ...spec, document: { ...doc, ...fields } };
}

/**
 * Generate a unique task name from a display name.
 * "Send Email" → "send-email", with suffix if duplicate: "send-email-2"
 */
export function generateTaskName(displayName: string, existingNames: string[]): string {
	const base = displayName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		|| 'task';

	if (!existingNames.includes(base)) return base;

	let i = 2;
	while (existingNames.includes(`${base}-${i}`)) i++;
	return `${base}-${i}`;
}

/**
 * Create a default empty spec with document metadata.
 */
export function createEmptySpec(name: string = 'untitled', title: string = 'Untitled'): Spec {
	return {
		document: {
			dsl: '1.0.0',
			namespace: 'workflow-builder',
			name,
			version: '1.0.0',
			title,
		},
		do: [],
	};
}
