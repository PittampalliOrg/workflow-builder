// Svelte 5 runes-based wizard state shared across the 3 wizard steps.
// Imported as a module so all step panels read/write the same instance.

export type WizardPreset =
	| 'completions'
	| 'prompt-with-ground-truth'
	| 'externalData'
	| 'swebench'
	| null;

export type DataSourceKind = 'manual' | 'upload' | 'logs' | 'api' | 'swebench';

export type WizardRow = {
	input: string;
	ground_truth: string;
};

export type GraderType =
	| 'string_check'
	| 'text_similarity'
	| 'score_model'
	| 'python'
	| 'multi'
	| 'external_harness'
	| 'endpoint'
	| 'mlflow_judge';

export type WizardGrader = {
	id: string;
	name: string;
	type: GraderType;
	config: Record<string, unknown>;
	weight?: number;
	passThreshold?: number;
	enabled: boolean;
};

export type SubjectKind = 'agent' | 'workflow' | 'imported_outputs';

export type WizardSubject = {
	type: SubjectKind;
	id?: string;
	version?: string;
	importedOutputs?: string;
};

export type WizardState = {
	step: 1 | 2 | 3;
	preset: WizardPreset;
	dataSource: DataSourceKind;
	rows: WizardRow[];
	uploadFormat: 'jsonl' | 'json' | 'csv';
	uploadContent: string;
	criteria: WizardGrader[];
	name: string;
	description: string;
	subject: WizardSubject;
	concurrency: number;
	timeoutSeconds: number;
	swebenchSuiteSlug: string;
	swebenchInstanceIds: string;
};

function emptyState(): WizardState {
	return {
		step: 1,
		preset: null,
		dataSource: 'manual',
		rows: [],
		uploadFormat: 'jsonl',
		uploadContent: '',
		criteria: [],
		name: '',
		description: '',
		subject: { type: 'agent' },
		concurrency: 1,
		timeoutSeconds: 7200,
		swebenchSuiteSlug: 'SWE-bench_Lite',
		swebenchInstanceIds: ''
	};
}

let state = $state<WizardState>(emptyState());

export function getWizardState(): WizardState {
	return state;
}

export function resetWizard(preset: WizardPreset = null) {
	const next = emptyState();
	next.preset = preset;
	if (preset === 'externalData') next.dataSource = 'upload';
	if (preset === 'completions') next.dataSource = 'logs';
	if (preset === 'prompt-with-ground-truth' || preset === 'swebench') next.dataSource = 'manual';
	state.step = next.step;
	state.preset = next.preset;
	state.dataSource = next.dataSource;
	state.rows = next.rows;
	state.uploadFormat = next.uploadFormat;
	state.uploadContent = next.uploadContent;
	state.criteria = next.criteria;
	state.name = next.name;
	state.description = next.description;
	state.subject = next.subject;
	state.concurrency = next.concurrency;
	state.timeoutSeconds = next.timeoutSeconds;
	state.swebenchSuiteSlug = next.swebenchSuiteSlug;
	state.swebenchInstanceIds = next.swebenchInstanceIds;
	if (preset === 'swebench') state.dataSource = 'swebench';
}

export function setStep(step: 1 | 2 | 3) {
	state.step = step;
}

export function addRow(row: WizardRow = { input: '', ground_truth: '' }) {
	state.rows = [...state.rows, row];
}

export function updateRow(index: number, patch: Partial<WizardRow>) {
	state.rows = state.rows.map((r, i) => (i === index ? { ...r, ...patch } : r));
}

export function removeRow(index: number) {
	state.rows = state.rows.filter((_, i) => i !== index);
}

export function addCriterion(c: WizardGrader) {
	state.criteria = [...state.criteria, c];
}

export function removeCriterion(id: string) {
	state.criteria = state.criteria.filter((c) => c.id !== id);
}

export function step1Valid(): boolean {
	if (state.dataSource === 'manual') {
		return state.rows.length > 0 && state.rows.every((r) => r.input.trim().length > 0);
	}
	if (state.dataSource === 'upload') return state.uploadContent.trim().length > 0;
	if (state.dataSource === 'swebench') return state.swebenchSuiteSlug.trim().length > 0;
	return false;
}

export function step3Valid(): boolean {
	if (!state.name.trim()) return false;
	if (state.subject.type === 'agent' && !state.subject.id) return false;
	if (state.subject.type === 'workflow' && !state.subject.id) return false;
	if (state.subject.type === 'imported_outputs' && !state.subject.importedOutputs?.trim()) {
		return false;
	}
	return true;
}
