type MonacoPositionLike = {
	lineNumber: number;
	column: number;
};

type MonacoRangeLike = {
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
};

type MonacoWordLike = {
	word: string;
	startColumn: number;
	endColumn: number;
};

type MonacoModelLike = {
	uri?: { toString: () => string };
	getValueInRange: (range: MonacoRangeLike) => string;
	getWordUntilPosition?: (position: MonacoPositionLike) => MonacoWordLike;
};

export type MonacoLike = {
	languages: {
		register: (language: { id: string }) => void;
		setMonarchTokensProvider: (
			languageId: string,
			provider: Record<string, unknown>,
		) => void;
		registerCompletionItemProvider: (
			languageId: string,
			provider: Record<string, unknown>,
		) => { dispose: () => void };
		registerHoverProvider: (
			languageId: string,
			provider: Record<string, unknown>,
		) => { dispose: () => void };
		CompletionItemKind: Record<string, number>;
		CompletionItemInsertTextRule: Record<string, number>;
	};
};

type CelObjectRoot = "input" | "state" | "workflow" | "last";

export type CelEditorContext = {
	memberFields?: Partial<Record<CelObjectRoot, string[]>>;
};

type SetupCelLanguageOptions = {
	modelUri?: string;
	context?: CelEditorContext;
};

const DEFAULT_MEMBER_FIELDS: Record<CelObjectRoot, string[]> = {
	input: [
		"success",
		"data",
		"error",
		"text",
		"toolCalls",
		"fileChanges",
		"daprInstanceId",
	],
	state: [],
	workflow: ["id", "name", "input", "input_as_text"],
	last: [
		"success",
		"data",
		"error",
		"text",
		"toolCalls",
		"fileChanges",
		"daprInstanceId",
	],
};

const ROOT_HOVER_DOCS: Record<string, string> = {
	input:
		"Current loop input object. Usually the last loop-body output; fallback is workflow trigger input.",
	state:
		"Workflow state map set by set-state nodes. Access values with state.<key>.",
	workflow:
		"Workflow metadata and original input. Fields: workflow.id, workflow.name, workflow.input, workflow.input_as_text.",
	iteration:
		"Loop iteration counter managed by the loop runtime. Example: iteration < 10.",
	last: "Last loop-body output object (or null). Use null checks before deep field access.",
};

const WORKFLOW_FIELD_HOVER_DOCS: Record<string, string> = {
	id: "Workflow ID.",
	name: "Workflow display name.",
	input: "Original workflow trigger input object.",
	input_as_text: "Stringified trigger input.",
};

const COMMON_SNIPPETS: Array<{
	label: string;
	insertText: string;
	detail: string;
}> = [
	{
		label: "while: iteration limit",
		insertText: "iteration < ${1:10}",
		detail: "Loop while iteration is below a limit",
	},
	{
		label: "while: state key equals",
		insertText: 'state.${1:key} == ${2:"value"}',
		detail: "Loop gate based on a workflow state value",
	},
	{
		label: "while: last output has data",
		insertText:
			"last == null ? false : has(last.data) && last.data.${1:field} != null",
		detail: "Continue only when last output has the expected field",
	},
	{
		label: "while: input success check",
		insertText: "input != null && input.success == true",
		detail: "Continue only when input indicates success",
	},
	{
		label: "while: workflow text contains",
		insertText: 'workflow.input_as_text.contains(${1:"keyword"})',
		detail: "Evaluate using original workflow input text",
	},
];

let celLanguageRegistered = false;
let celCompletionProviderRegistered = false;
let celHoverProviderRegistered = false;
let fallbackCelContext: CelEditorContext = {};
const celContextByModelUri = new Map<string, CelEditorContext>();

function dedupe(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

function mergeContextMemberFields(
	root: CelObjectRoot,
	context: CelEditorContext,
): string[] {
	const fromContext = context.memberFields?.[root] ?? [];
	return dedupe([...DEFAULT_MEMBER_FIELDS[root], ...fromContext]);
}

function getContextForModel(model: MonacoModelLike): CelEditorContext {
	const modelUri = model.uri?.toString();
	if (modelUri && celContextByModelUri.has(modelUri)) {
		return celContextByModelUri.get(modelUri) ?? fallbackCelContext;
	}
	return fallbackCelContext;
}

function getLinePrefix(
	model: MonacoModelLike,
	position: MonacoPositionLike,
): string {
	return model.getValueInRange({
		startLineNumber: position.lineNumber,
		startColumn: 1,
		endLineNumber: position.lineNumber,
		endColumn: position.column,
	});
}

function getReplacementRange(
	model: MonacoModelLike,
	position: MonacoPositionLike,
): MonacoRangeLike | undefined {
	const word = model.getWordUntilPosition?.(position);
	if (!word) return undefined;
	return {
		startLineNumber: position.lineNumber,
		startColumn: word.startColumn,
		endLineNumber: position.lineNumber,
		endColumn: word.endColumn,
	};
}

function buildMemberSuggestions(
	monaco: MonacoLike,
	root: CelObjectRoot,
	context: CelEditorContext,
	range: MonacoRangeLike | undefined,
): Array<Record<string, unknown>> {
	return mergeContextMemberFields(root, context).map((field) => ({
		label: field,
		kind: monaco.languages.CompletionItemKind.Field,
		insertText: field,
		detail: `${root}.${field}`,
		range,
	}));
}

function filterByPrefix(
	suggestions: Array<Record<string, unknown>>,
	prefix: string,
): Array<Record<string, unknown>> {
	if (!prefix) return suggestions;
	return suggestions.filter((suggestion) => {
		const label = suggestion.label;
		return typeof label === "string"
			? label.toLowerCase().startsWith(prefix.toLowerCase())
			: true;
	});
}

function toMarkdownBlock(text: string): string {
	return `**CEL Context**\n\n${text}`;
}

function getHoverAtPosition(
	model: MonacoModelLike,
	position: MonacoPositionLike,
	context: CelEditorContext,
): { contents: Array<{ value: string }> } | null {
	const linePrefix = getLinePrefix(model, position);
	const memberMatch = linePrefix.match(
		/(input|state|workflow|last)\.([a-zA-Z_]\w*)?$/,
	);

	if (memberMatch) {
		const root = memberMatch[1] as CelObjectRoot;
		const field = memberMatch[2] ?? "";
		if (!field) {
			const fields = mergeContextMemberFields(root, context);
			return {
				contents: [
					{
						value: toMarkdownBlock(
							`Available fields for \`${root}\`: ${fields.length > 0 ? fields.map((v) => `\`${v}\``).join(", ") : "none detected"}.`,
						),
					},
				],
			};
		}

		if (root === "workflow" && WORKFLOW_FIELD_HOVER_DOCS[field]) {
			return {
				contents: [
					{
						value: toMarkdownBlock(
							`\`workflow.${field}\` - ${WORKFLOW_FIELD_HOVER_DOCS[field]}`,
						),
					},
				],
			};
		}

		const knownFields = mergeContextMemberFields(root, context);
		if (knownFields.includes(field)) {
			return {
				contents: [
					{
						value: toMarkdownBlock(
							`\`${root}.${field}\` is available in this loop context.`,
						),
					},
				],
			};
		}
	}

	const word = model.getWordUntilPosition?.(position)?.word ?? "";
	if (word && ROOT_HOVER_DOCS[word]) {
		return {
			contents: [
				{
					value: toMarkdownBlock(`\`${word}\` - ${ROOT_HOVER_DOCS[word]}`),
				},
			],
		};
	}

	return null;
}

export function setupCelLanguage(
	monaco: MonacoLike,
	options?: SetupCelLanguageOptions,
): void {
	if (options?.context) {
		fallbackCelContext = options.context;
	}
	if (options?.modelUri && options?.context) {
		celContextByModelUri.set(options.modelUri, options.context);
	}

	if (!celLanguageRegistered) {
		celLanguageRegistered = true;
		monaco.languages.register({ id: "cel" });

		monaco.languages.setMonarchTokensProvider("cel", {
			tokenizer: {
				root: [
					[/\/\/.*$/, "comment"],
					[/\b(true|false|null)\b/, "keyword"],
					[/\b(in|all|exists|exists_one|map|filter)\b/, "keyword"],
					[/\b(size|has)\b/, "type.identifier"],
					[/[a-zA-Z_]\w*/, "identifier"],
					[/[0-9]+(?:\.[0-9]+)?/, "number"],
					[/"([^"\\]|\\.)*$/, "string.invalid"],
					[/"/, { token: "string.quote", bracket: "@open", next: "@string" }],
					[/[{}()[\]]/, "@brackets"],
					[/[<>!=~?:&|+\-*/%]+/, "operator"],
					[/[,.;]/, "delimiter"],
				],
				string: [
					[/[^\\"]+/, "string"],
					[/\\./, "string.escape"],
					[/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
				],
			},
		});
	}

	if (!celCompletionProviderRegistered) {
		celCompletionProviderRegistered = true;

		monaco.languages.registerCompletionItemProvider("cel", {
			triggerCharacters: ["."],
			provideCompletionItems: (
				model: MonacoModelLike,
				position: MonacoPositionLike,
			) => {
				const context = getContextForModel(model);
				const range = getReplacementRange(model, position);
				const linePrefix = getLinePrefix(model, position);
				const memberMatch = linePrefix.match(
					/(input|state|workflow|last)\.([a-zA-Z_]\w*)?$/,
				);

				if (memberMatch) {
					const root = memberMatch[1] as CelObjectRoot;
					const partial = memberMatch[2] ?? "";
					const memberSuggestions = buildMemberSuggestions(
						monaco,
						root,
						context,
						range,
					);
					return { suggestions: filterByPrefix(memberSuggestions, partial) };
				}

				const rootSuggestions: Array<Record<string, unknown>> = [
					{
						label: "input",
						kind: monaco.languages.CompletionItemKind.Variable,
						insertText: "input",
						detail: "Last loop-body output (fallback: workflow input)",
						documentation: ROOT_HOVER_DOCS.input,
						range,
					},
					{
						label: "state",
						kind: monaco.languages.CompletionItemKind.Variable,
						insertText: "state",
						detail: "Workflow state variables",
						documentation: ROOT_HOVER_DOCS.state,
						range,
					},
					{
						label: "workflow",
						kind: monaco.languages.CompletionItemKind.Variable,
						insertText: "workflow",
						detail: "Workflow metadata and original input",
						documentation: ROOT_HOVER_DOCS.workflow,
						range,
					},
					{
						label: "iteration",
						kind: monaco.languages.CompletionItemKind.Variable,
						insertText: "iteration",
						detail: "Current loop iteration counter",
						documentation: ROOT_HOVER_DOCS.iteration,
						range,
					},
					{
						label: "last",
						kind: monaco.languages.CompletionItemKind.Variable,
						insertText: "last",
						detail: "Last loop-body output object (or null)",
						documentation: ROOT_HOVER_DOCS.last,
						range,
					},
					{
						label: "size()",
						kind: monaco.languages.CompletionItemKind.Function,
						insertText: "size(${1:value})",
						insertTextRules:
							monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
						detail: "CEL size macro",
						range,
					},
					{
						label: "all()",
						kind: monaco.languages.CompletionItemKind.Function,
						insertText: "${1:list}.all(${2:item}, ${3:predicate})",
						insertTextRules:
							monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
						detail: "CEL list macro",
						range,
					},
					{
						label: "exists()",
						kind: monaco.languages.CompletionItemKind.Function,
						insertText: "${1:list}.exists(${2:item}, ${3:predicate})",
						insertTextRules:
							monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
						detail: "CEL list macro",
						range,
					},
					{
						label: "in",
						kind: monaco.languages.CompletionItemKind.Keyword,
						insertText: " in ",
						detail: "Membership operator",
						range,
					},
				];

				const snippetSuggestions = COMMON_SNIPPETS.map((snippet) => ({
					label: snippet.label,
					kind: monaco.languages.CompletionItemKind.Snippet,
					insertText: snippet.insertText,
					insertTextRules:
						monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
					detail: snippet.detail,
					range,
				}));

				const wordPrefix = model.getWordUntilPosition?.(position)?.word ?? "";
				return {
					suggestions: filterByPrefix(
						[...snippetSuggestions, ...rootSuggestions],
						wordPrefix,
					),
				};
			},
		});
	}

	if (celHoverProviderRegistered) return;
	celHoverProviderRegistered = true;

	monaco.languages.registerHoverProvider("cel", {
		provideHover: (model: MonacoModelLike, position: MonacoPositionLike) => {
			const context = getContextForModel(model);
			return getHoverAtPosition(model, position, context);
		},
	});
}
