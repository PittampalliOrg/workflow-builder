export type AgentSkillConfig = {
	name: string;
	description?: string;
	prompt: string;
	whenToUse?: string;
	allowedTools?: string[];
	arguments?: string[];
	argumentHint?: string;
	model?: string;
	userInvocable?: boolean;
	disableModelInvocation?: boolean;
	sourceType?: 'profile' | 'inline' | 'preset';
};

export const CLAUDE_CODE_BUNDLED_SKILLS: AgentSkillConfig[] = [
	{
		name: 'simplify',
		description:
			'Review changed code for reuse, quality, and efficiency, then fix any issues found.',
		whenToUse:
			'Use when the user asks to simplify, clean up, reduce duplication, improve maintainability, or review recent changes for quality and efficiency.',
		prompt:
			'Source: claude-code-src/main/skills/bundled/simplify.ts\n\nReview changed files for reuse, quality, and efficiency. Start by inspecting the git diff or the files named by the user. Make three direct review passes: code reuse, code quality, and efficiency. Look for duplicated utilities, redundant state, copy-paste, leaky abstractions, brittle stringly-typed logic, unnecessary comments, repeated work, missed concurrency, hot-path bloat, no-op updates, and leaks. Fix clear issues directly, skip false positives, run focused checks when available, and summarize what changed. Additional focus: ${ARGUMENTS}',
		allowedTools: ['read_file', 'list_files', 'edit_file', 'write_file', 'execute_command'],
		arguments: ['focus'],
		argumentHint: 'Optional area or concern to focus on.',
		userInvocable: true,
		disableModelInvocation: false,
		sourceType: 'profile'
	},
	{
		name: 'debug',
		description: 'Enable evidence-first debugging and help diagnose issues.',
		whenToUse:
			'Use when the user reports an error, failure, bad log output, stalled workflow, broken run, or unexpected behavior.',
		prompt:
			'Source: claude-code-src/main/skills/bundled/debug.ts\n\nHelp debug the reported issue. Gather evidence before proposing a fix: inspect relevant logs, recent workflow run state, configuration, code paths, tests, and recent diffs. Search for error and warning patterns where logs are available. Explain the likely root cause in plain language, apply the smallest safe fix when implementation is requested, and verify the result. Issue description: ${ARGUMENTS}',
		allowedTools: ['read_file', 'list_files', 'edit_file', 'write_file', 'execute_command'],
		arguments: ['issue'],
		argumentHint: 'Error message, symptom, workflow run id, or failing behavior.',
		userInvocable: true,
		disableModelInvocation: false,
		sourceType: 'profile'
	},
	{
		name: 'skillify',
		description: "Capture a repeatable process as a reusable skill.",
		whenToUse:
			'Use when the user wants to convert a successful repeated process into a reusable skill or profile skill.',
		prompt:
			'Source: claude-code-src/main/skills/bundled/skillify.ts\n\nCapture the process described by the user as a reusable workflow-builder skill configuration. Analyze the repeatable goal, required inputs, ordered steps, success criteria, needed tools, invocation triggers, and gotchas. Produce a proposed skill object with name, description, whenToUse, argumentHint, arguments, allowedTools, and prompt. Do not save or mutate anything unless explicitly asked. Process to capture: ${ARGUMENTS}',
		allowedTools: ['read_file', 'list_files', 'edit_file', 'write_file', 'execute_command'],
		arguments: ['description'],
		argumentHint: 'Description of the process to capture.',
		userInvocable: true,
		disableModelInvocation: false,
		sourceType: 'profile'
	},
	{
		name: 'remember',
		description:
			'Review memory-like project guidance and propose cleanup or promotion changes.',
		whenToUse:
			'Use when the user wants to review, organize, preserve, or clean up project instructions, agent memory, CLAUDE.md-style guidance, or workflow-builder profile knowledge.',
		prompt:
			'Source: claude-code-src/main/skills/bundled/remember.ts\n\nReview the requested memory or guidance landscape. Gather relevant project instructions, profile notes, workflow conventions, and memory-like files when available. Classify each useful item as project guidance, local/personal guidance, profile-level reusable knowledge, or temporary context. Identify duplicates, outdated statements, and conflicts. Present proposed changes grouped by action and do not modify files without explicit approval. Additional context: ${ARGUMENTS}',
		allowedTools: ['read_file', 'list_files', 'edit_file', 'write_file', 'execute_command'],
		arguments: ['context'],
		argumentHint: 'Memory, guidance, or profile knowledge to review.',
		userInvocable: true,
		disableModelInvocation: false,
		sourceType: 'profile'
	},
	{
		name: 'claude-api',
		description: 'Load Claude API guidance for implementation work.',
		whenToUse:
			'Use when the task involves Anthropic APIs, Claude SDKs, tool use, streaming, batches, structured outputs, files, errors, or Claude Agent SDK behavior.',
		prompt:
			'Source: claude-code-src/main/skills/bundled/claudeApi.ts\n\nHelp with Anthropic or Claude API implementation. Identify the language and SDK in use from the project when possible. Prefer current official documentation when available. Focus on the relevant API shape, tool use, streaming, batches, structured outputs, files, prompt caching, retries, and error handling. If no language is clear, ask for the target language before making broad changes. Request: ${ARGUMENTS}',
		allowedTools: ['read_file', 'list_files', 'edit_file', 'write_file', 'execute_command'],
		arguments: ['request'],
		argumentHint: 'API question, feature, bug, or target SDK/language.',
		userInvocable: true,
		disableModelInvocation: false,
		sourceType: 'profile'
	}
];
