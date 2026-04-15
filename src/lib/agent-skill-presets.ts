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
	sourceType?: 'profile' | 'inline' | 'preset' | 'registry' | 'curated' | 'imported' | 'builtin';
	registryId?: string;
	slug?: string;
	version?: string;
	contentHash?: string;
	sourceRepo?: string;
	sourceRef?: string;
	skillPath?: string;
	license?: string;
	compatibility?: Record<string, unknown>;
	packageManifest?: Record<string, unknown>;
	status?: 'ENABLED' | 'DISABLED' | 'DRAFT';
};

export type AgentSkillRegistryEntry = AgentSkillConfig & {
	id: string;
	slug: string;
	status: 'ENABLED' | 'DISABLED' | 'DRAFT';
	sourceType: 'curated' | 'imported' | 'builtin';
};

export const CLAUDE_CODE_BUNDLED_SKILLS: AgentSkillRegistryEntry[] = [
	{
		id: 'builtin:simplify',
		slug: 'simplify',
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
		sourceType: 'builtin',
		version: '1',
		contentHash: 'builtin:simplify:v1',
		sourceRepo: 'claude-code-src',
		sourceRef: 'main',
		skillPath: 'skills/bundled/simplify.ts',
		status: 'ENABLED'
	},
	{
		id: 'builtin:debug',
		slug: 'debug',
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
		sourceType: 'builtin',
		version: '1',
		contentHash: 'builtin:debug:v1',
		sourceRepo: 'claude-code-src',
		sourceRef: 'main',
		skillPath: 'skills/bundled/debug.ts',
		status: 'ENABLED'
	},
	{
		id: 'builtin:skillify',
		slug: 'skillify',
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
		sourceType: 'builtin',
		version: '1',
		contentHash: 'builtin:skillify:v1',
		sourceRepo: 'claude-code-src',
		sourceRef: 'main',
		skillPath: 'skills/bundled/skillify.ts',
		status: 'ENABLED'
	},
	{
		id: 'builtin:remember',
		slug: 'remember',
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
		sourceType: 'builtin',
		version: '1',
		contentHash: 'builtin:remember:v1',
		sourceRepo: 'claude-code-src',
		sourceRef: 'main',
		skillPath: 'skills/bundled/remember.ts',
		status: 'ENABLED'
	},
	{
		id: 'builtin:claude-api',
		slug: 'claude-api',
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
		sourceType: 'builtin',
		version: '1',
		contentHash: 'builtin:claude-api:v1',
		sourceRepo: 'claude-code-src',
		sourceRef: 'main',
		skillPath: 'skills/bundled/claudeApi.ts',
		status: 'ENABLED'
	}
];

export const VERCEL_CURATED_SKILLS: AgentSkillRegistryEntry[] = [
	{
		id: 'curated:vercel-react-best-practices',
		slug: 'vercel-react-best-practices',
		name: 'vercel-react-best-practices',
		description:
			'Review React and Next.js code for performance, component boundaries, rendering, and maintainability.',
		whenToUse:
			'Use when implementing or reviewing React, Next.js, SvelteKit-adjacent frontend code, component APIs, or rendering performance.',
		prompt:
			'Source: skills.sh vercel-react-best-practices\n\nReview the requested frontend work for production React and Next.js best practices. Focus on component boundaries, state placement, rendering cost, cache/data-loading correctness, accessibility, bundle weight, and maintainable APIs. Apply these guidelines pragmatically to this codebase and call out framework differences when the target is SvelteKit instead of React. Request: ${ARGUMENTS}',
		allowedTools: ['read_file', 'list_files', 'edit_file', 'write_file', 'execute_command'],
		arguments: ['request'],
		argumentHint: 'Frontend feature, file, or review focus.',
		userInvocable: true,
		disableModelInvocation: false,
		sourceType: 'curated',
		version: '1',
		contentHash: 'curated:vercel-react-best-practices:v1',
		sourceRepo: 'https://skills.sh/vercel-react-best-practices',
		sourceRef: '2026-02-17',
		skillPath: 'SKILL.md',
		license: 'unknown',
		status: 'ENABLED'
	},
	{
		id: 'curated:web-design-guidelines',
		slug: 'web-design-guidelines',
		name: 'web-design-guidelines',
		description:
			'Review interface work for accessibility, responsive behavior, visual consistency, and interaction quality.',
		whenToUse:
			'Use when designing, implementing, or reviewing user-facing web UI.',
		prompt:
			'Source: skills.sh web-design-guidelines\n\nReview the UI against production web interface guidelines. Check accessibility, responsive layout, keyboard interaction, focus states, stable dimensions, copy clarity, contrast, loading states, and error states. Prefer concrete fixes over abstract critique. Request: ${ARGUMENTS}',
		allowedTools: ['read_file', 'list_files', 'edit_file', 'write_file', 'execute_command'],
		arguments: ['request'],
		argumentHint: 'UI surface, screenshot finding, or implementation request.',
		userInvocable: true,
		disableModelInvocation: false,
		sourceType: 'curated',
		version: '1',
		contentHash: 'curated:web-design-guidelines:v1',
		sourceRepo: 'https://skills.sh/web-design-guidelines',
		sourceRef: '2026-02-17',
		skillPath: 'SKILL.md',
		license: 'unknown',
		status: 'ENABLED'
	},
	{
		id: 'curated:ai-sdk',
		slug: 'ai-sdk',
		name: 'ai-sdk',
		description:
			'Help implement AI SDK features including agents, chat, streaming, tools, and structured output.',
		whenToUse:
			'Use when the task involves the Vercel AI SDK, model calls, streaming UI, tools, or structured generation.',
		prompt:
			'Source: skills.sh ai-sdk\n\nHelp with AI SDK implementation. Inspect the project version and existing patterns, then implement or review chat, agent, tool-calling, streaming, structured output, error handling, and provider configuration. Prefer current official docs when available. Request: ${ARGUMENTS}',
		allowedTools: ['read_file', 'list_files', 'edit_file', 'write_file', 'execute_command'],
		arguments: ['request'],
		argumentHint: 'AI SDK question, feature, or bug.',
		userInvocable: true,
		disableModelInvocation: false,
		sourceType: 'curated',
		version: '1',
		contentHash: 'curated:ai-sdk:v1',
		sourceRepo: 'https://skills.sh/ai-sdk',
		sourceRef: '2026-02-17',
		skillPath: 'SKILL.md',
		license: 'unknown',
		status: 'ENABLED'
	},
	{
		id: 'curated:agent-browser',
		slug: 'agent-browser',
		name: 'agent-browser',
		description:
			'Guide browser automation runs with navigation, interaction, screenshots, and issue capture.',
		whenToUse:
			'Use when validating an app in a browser, producing screenshots, testing UI flows, or extracting page state.',
		prompt:
			'Source: skills.sh agent-browser\n\nAutomate browser validation with a clear test objective. Start the app if needed, navigate to the target URL, inspect console/network errors, exercise the requested flows, capture screenshots of important states, and summarize reproducible issues with steps and evidence. Request: ${ARGUMENTS}',
		allowedTools: [
			'read_file',
			'list_files',
			'edit_file',
			'write_file',
			'execute_command',
			'browser_navigate',
			'browser_snapshot',
			'browser_click',
			'browser_type',
			'browser_take_screenshot'
		],
		arguments: ['request'],
		argumentHint: 'Browser flow or app feature to validate.',
		userInvocable: true,
		disableModelInvocation: false,
		sourceType: 'curated',
		version: '1',
		contentHash: 'curated:agent-browser:v1',
		sourceRepo: 'https://skills.sh/agent-browser',
		sourceRef: '2026-02-17',
		skillPath: 'SKILL.md',
		license: 'unknown',
		status: 'ENABLED'
	},
	{
		id: 'curated:workflow',
		slug: 'workflow',
		name: 'workflow',
		description:
			'Design durable step-based workflows with retries, idempotency, and observable execution state.',
		whenToUse:
			'Use when building or reviewing workflow orchestration, step retries, long-running jobs, or durable agent runs.',
		prompt:
			'Source: skills.sh workflow\n\nHelp design and implement durable workflows. Focus on idempotent steps, retries, compensation, state persistence, observable progress, timeouts, resumability, and clear input/output contracts. Map the advice to Serverless Workflow 1.0 and Dapr workflow patterns used in this repo. Request: ${ARGUMENTS}',
		allowedTools: ['read_file', 'list_files', 'edit_file', 'write_file', 'execute_command'],
		arguments: ['request'],
		argumentHint: 'Workflow behavior, failure mode, or implementation task.',
		userInvocable: true,
		disableModelInvocation: false,
		sourceType: 'curated',
		version: '1',
		contentHash: 'curated:workflow:v1',
		sourceRepo: 'https://skills.sh/workflow',
		sourceRef: '2026-02-17',
		skillPath: 'SKILL.md',
		license: 'unknown',
		status: 'ENABLED'
	}
];

export const DEFAULT_CURATED_AGENT_SKILLS: AgentSkillRegistryEntry[] = [
	...CLAUDE_CODE_BUNDLED_SKILLS,
	...VERCEL_CURATED_SKILLS
];

export function profileSkillSnapshot(skill: AgentSkillConfig): AgentSkillConfig {
	return {
		...skill,
		sourceType: 'profile',
		registryId: skill.registryId || ('id' in skill ? String(skill.id) : undefined),
		slug: skill.slug || skill.name
	};
}
