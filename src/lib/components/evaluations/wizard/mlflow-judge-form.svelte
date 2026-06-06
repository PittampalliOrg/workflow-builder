<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Select from '$lib/components/ui/select';
	import type { WizardGrader } from './wizard-store.svelte';

	interface Props {
		grader: WizardGrader;
		onChange: (next: WizardGrader) => void;
	}

	let { grader, onChange }: Props = $props();

	// Hard-coded list of MLflow AI Gateway routes (the 22 endpoints configured
	// per project_mlflow_ai_gateway_routes.md). The Gateway resolves each
	// to its provider + model + key. Free-text input is still allowed for
	// routes not in the list (forward-compat).
	const GATEWAY_ROUTES = [
		{ value: 'anthropic-opus', label: 'Anthropic — Claude Opus 4.7' },
		{ value: 'anthropic-sonnet', label: 'Anthropic — Claude Sonnet 4.6' },
		{ value: 'anthropic-haiku', label: 'Anthropic — Claude Haiku 4.5' },
		{ value: 'gpt-5.5', label: 'OpenAI - GPT-5.5' },
		{ value: 'o3', label: 'OpenAI — o3' },
		{ value: 'deepseek-v4-pro', label: 'DeepSeek — V4 Pro' },
		{ value: 'deepseek-v4-flash', label: 'DeepSeek — V4 Flash' },
		{ value: 'nvidia-llama31-8b', label: 'NVIDIA NIM — Llama 3.1 8B' },
		{ value: 'nvidia-glm47', label: 'NVIDIA NIM — GLM 4.7' },
		{ value: 'nvidia-kimi-k2-thinking', label: 'NVIDIA NIM — Kimi K2 Thinking' },
		{ value: 'nvidia-devstral-2-123b', label: 'NVIDIA NIM — Devstral 2 123B' },
		{ value: 'nvidia-mistral-medium-35-128b', label: 'NVIDIA NIM — Mistral Medium 3.5 128B' },
		{ value: 'nvidia-qwen3-coder-480b', label: 'NVIDIA NIM — Qwen 3 Coder 480B' },
		{ value: 'foundry-default', label: 'Azure AI Foundry — default' },
		{ value: 'kimi-k2', label: 'Moonshot — Kimi K2' },
		{ value: 'alibaba-qwen-max', label: 'Alibaba DashScope — Qwen Max' },
		{ value: 'together-default', label: 'Together AI — default' },
		{ value: 'google-gemini-pro', label: 'Google — Gemini 2.5 Pro' },
		{ value: 'google-gemini-flash', label: 'Google — Gemini 2.5 Flash' }
	] as const;

	const DEFAULT_RUBRIC = [
		'You are an evaluator. Score the model output against the expected behavior.',
		'',
		'Input:',
		'{{input}}',
		'',
		'Expected behavior:',
		'{{expected}}',
		'',
		'Actual model output:',
		'{{actual}}',
		'',
		'Respond with EXACTLY this format:',
		'VERDICT: <PASS|FAIL>',
		'RATIONALE: <one sentence>'
	].join('\n');

	const model = $derived((grader.config.model as string) ?? 'anthropic-haiku');
	const prompt = $derived((grader.config.prompt as string) ?? '');
	const passThreshold = $derived(
		typeof grader.config.passThreshold === 'number' ? grader.config.passThreshold : 0.5
	);

	function patch(next: Partial<typeof grader.config>) {
		onChange({ ...grader, config: { ...grader.config, ...next } });
	}

	function loadDefaultRubric() {
		patch({ prompt: DEFAULT_RUBRIC });
	}

	const modelLabel = $derived(
		GATEWAY_ROUTES.find((r) => r.value === model)?.label ?? model
	);
</script>

<div class="flex flex-col gap-3">
	<div class="flex flex-col gap-1.5">
		<Label class="text-xs">Name</Label>
		<Input
			value={grader.name}
			oninput={(e) => onChange({ ...grader, name: (e.target as HTMLInputElement).value })}
			class="text-sm"
		/>
	</div>

	<div class="flex flex-col gap-1.5">
		<Label class="text-xs">MLflow Gateway route</Label>
		<Select.Root type="single" value={model} onValueChange={(v) => patch({ model: v ?? 'anthropic-haiku' })}>
			<Select.Trigger class="text-sm">
				{modelLabel}
			</Select.Trigger>
			<Select.Content>
				{#each GATEWAY_ROUTES as route (route.value)}
					<Select.Item value={route.value}>{route.label}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
		<p class="text-[11px] text-muted-foreground">
			Routes through <code class="font-mono">mlflow-ai-gateway-hub-egress:7000</code> →
			LiteLLM. The Gateway resolves provider, model, and API key.
		</p>
	</div>

	<div class="flex flex-col gap-1.5">
		<div class="flex items-center justify-between">
			<Label class="text-xs">Rubric prompt</Label>
			<Button size="sm" variant="ghost" onclick={loadDefaultRubric} class="h-6 text-[11px]">
				Insert default rubric
			</Button>
		</div>
		<Textarea
			value={prompt}
			oninput={(e) => patch({ prompt: (e.target as HTMLTextAreaElement).value })}
			rows={10}
			placeholder={DEFAULT_RUBRIC}
			class="font-mono text-xs"
		/>
		<p class="text-[11px] text-muted-foreground">
			Template variables: <code>{`{{input}}`}</code>, <code>{`{{expected}}`}</code>,
			<code>{`{{actual}}`}</code>. The judge looks for <code>VERDICT: GOOD</code> /
			<code>VERDICT: BAD</code> (PASS/FAIL also accepted) and scores 1.0 / 0.0 accordingly.
		</p>
	</div>

	<div class="flex flex-col gap-1.5">
		<Label class="text-xs">Pass threshold</Label>
		<Input
			type="number"
			min="0"
			max="1"
			step="0.05"
			value={passThreshold}
			oninput={(e) => patch({ passThreshold: Number((e.target as HTMLInputElement).value) })}
			class="text-sm w-28"
		/>
		<p class="text-[11px] text-muted-foreground">
			Score ≥ threshold counts as a pass. Default 0.5 (PASS = 1.0, FAIL = 0.0).
		</p>
	</div>
</div>
