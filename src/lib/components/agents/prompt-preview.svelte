<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import {
		Tabs,
		TabsContent,
		TabsList,
		TabsTrigger
	} from '$lib/components/ui/tabs';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Check, Copy } from '@lucide/svelte';
	import type { PromptWorkbenchPreview } from '$lib/agents/prompt-workbench-renderer';

	interface Props {
		preview: PromptWorkbenchPreview;
		compact?: boolean;
	}

	let { preview, compact = false }: Props = $props();
	let tab = $state<'rendered' | 'variables' | 'sources'>('rendered');
	let copied = $state<string | null>(null);

	async function copy(text: string) {
		try {
			await navigator.clipboard?.writeText(text);
			copied = text;
			setTimeout(() => {
				if (copied === text) copied = null;
			}, 1200);
		} catch {
			/* clipboard may be blocked */
		}
	}

	function shortHash(value: string | null | undefined) {
		return value ? value.slice(0, 12) : 'unavailable';
	}
</script>

<div class="min-w-0 rounded-md border bg-background">
	<div class="border-b p-3">
		<div class="flex items-center justify-between gap-2">
			<div class="min-w-0">
				<div class="text-sm font-semibold">Compiled Prompt</div>
				<div class="mt-1 flex flex-wrap items-center gap-1.5">
					{#if preview.audit.agentName}
						<Badge variant="secondary">{preview.audit.agentName}</Badge>
					{/if}
					<Badge variant="outline" class="font-mono text-[10px]">
						v{preview.audit.agentVersion ?? 'current'}
					</Badge>
					<Badge variant="outline" class="font-mono text-[10px]">
						cfg {shortHash(preview.audit.configHash)}
					</Badge>
				</div>
			</div>
			<Badge variant="outline" class="font-mono text-[10px]">
				{preview.audit.templateFormat}
			</Badge>
		</div>
		<div class="mt-2 grid gap-1 text-[11px] text-muted-foreground">
			<div class="flex min-w-0 gap-2">
				<span class="shrink-0 text-foreground/80">Template</span>
				<span class="truncate">{preview.audit.canonicalTemplateName}</span>
			</div>
			<div class="flex min-w-0 gap-2">
				<span class="shrink-0 text-foreground/80">Template hash</span>
				<span class="font-mono break-all">{shortHash(preview.audit.canonicalTemplateHash)}</span>
			</div>
			{#if preview.audit.presetName}
				<div class="flex min-w-0 gap-2">
					<span class="shrink-0 text-foreground/80">Preset</span>
					<span class="truncate">
						{preview.audit.presetName} v{preview.audit.presetVersion ?? 'latest'}
						{#if preview.audit.presetTemplateHash}
							<span class="font-mono">({shortHash(preview.audit.presetTemplateHash)})</span>
						{/if}
					</span>
				</div>
			{/if}
			<div class="flex min-w-0 gap-2">
				<span class="shrink-0 text-foreground/80">Instruction hash</span>
				<span class="font-mono break-all">{shortHash(preview.audit.instructionHash)}</span>
			</div>
		</div>
	</div>

	<Tabs value={tab} onValueChange={(value) => (tab = value as typeof tab)} class="min-h-0">
		<TabsList class="mx-3 mt-3">
			<TabsTrigger value="rendered">Rendered</TabsTrigger>
			<TabsTrigger value="variables">Variables</TabsTrigger>
			<TabsTrigger value="sources">Sources</TabsTrigger>
		</TabsList>

		<TabsContent value="rendered" class="space-y-3 p-3 pt-2">
			{#if preview.warnings.length > 0}
				<Alert>
					<AlertDescription class="space-y-1 text-xs">
						{#each preview.warnings as warning}
							<div>{warning.message}</div>
						{/each}
					</AlertDescription>
				</Alert>
			{/if}

			{#if preview.presetMessages.length > 0}
				<div class="space-y-2">
					<div class="flex items-center gap-2 text-xs font-medium">
						Preset rendered messages
						<Badge variant="secondary" class="text-[10px]">Not sent in v1</Badge>
					</div>
					{#each preview.presetMessages as message, index}
						<div class="rounded border bg-muted/20 p-2">
							<div class="mb-1 flex items-center justify-between gap-2">
								<Badge variant="outline" class="text-[10px]">{message.role}</Badge>
								<Button
									variant="ghost"
									size="icon-xs"
									title="Copy message"
									onclick={() => copy(message.content)}
								>
									{#if copied === message.content}
										<Check class="size-3" />
									{:else}
										<Copy class="size-3" />
									{/if}
								</Button>
							</div>
							<pre class="max-h-48 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed"><code>{message.content}</code></pre>
							{#if message.unresolvedVariables.length > 0}
								<div class="mt-1 text-[11px] text-amber-600 dark:text-amber-300">
									Unresolved: {message.unresolvedVariables.map((v) => `{{${v}}}`).join(', ')}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			<div class="space-y-2">
				<div class="flex items-center justify-between gap-2">
					<div class="text-xs font-medium">System message</div>
					<Button
						variant="ghost"
						size="icon-xs"
						title="Copy system message"
						onclick={() => copy(preview.systemMessage)}
					>
						{#if copied === preview.systemMessage}
							<Check class="size-3" />
						{:else}
							<Copy class="size-3" />
						{/if}
					</Button>
				</div>
				<pre class="overflow-auto whitespace-pre-wrap rounded border bg-muted/20 p-2 text-[11px] leading-relaxed {compact ? 'max-h-72' : 'max-h-[48rem]'}"><code>{preview.systemMessage || 'No system content yet.'}</code></pre>
			</div>

			<div class="rounded border bg-muted/20 p-2">
				<div class="mb-1 flex items-center gap-2 text-xs font-medium">
					Chat history placeholder
				</div>
				<code class="text-[11px]">{'{' + preview.chatHistoryPlaceholder + '}'}</code>
			</div>

			<div class="space-y-2">
				<div class="flex items-center gap-2 text-xs font-medium">
					Appended user message
					{#if preview.appendedUserVariables.length > 0}
						<Badge variant="secondary" class="text-[10px]">Not sent in v1</Badge>
					{/if}
				</div>
				<pre class="max-h-48 overflow-auto whitespace-pre-wrap rounded border bg-muted/20 p-2 text-[11px] leading-relaxed"><code>{preview.appendedUserMessage || 'Empty user message.'}</code></pre>
			</div>
		</TabsContent>

		<TabsContent value="variables" class="space-y-3 p-3 pt-2">
			{#each preview.variableCategories as category}
				<div class="space-y-2">
					<div class="text-xs font-semibold">{category.label}</div>
					<div class="flex flex-wrap gap-1.5">
						{#each category.variables as variable}
							<button
								type="button"
								class="group rounded border bg-muted/30 px-2 py-1 text-left text-[11px] hover:bg-muted"
								title={variable.description ?? variable.sample}
								onclick={() => copy(variable.placeholder)}
							>
								<span class="font-mono">{variable.placeholder}</span>
								<span class="ml-1 text-muted-foreground">{variable.sample}</span>
							</button>
						{/each}
					</div>
				</div>
			{/each}
		</TabsContent>

		<TabsContent value="sources" class="space-y-3 p-3 pt-2">
			<div class="grid gap-1.5 text-xs">
				{#each preview.sources as source}
					<div class="flex min-w-0 justify-between gap-3 rounded border bg-muted/20 px-2 py-1.5">
						<span class="text-muted-foreground">{source.label}</span>
						<span class="truncate font-mono">{source.value}</span>
					</div>
				{/each}
			</div>
		</TabsContent>
	</Tabs>
</div>
