<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Plus, Trash2 } from 'lucide-svelte';
	import type { AgentHooksConfig, AgentHookMatcher, AgentHookDefinition } from '$lib/types/agents';

	interface Props {
		value: AgentHooksConfig | undefined;
		onChange: (next: AgentHooksConfig | undefined) => void;
	}

	let { value, onChange }: Props = $props();

	const EVENTS = [
		'PreToolUse',
		'PostToolUse',
		'PostToolUseFailure',
		'UserPromptSubmit',
		'SessionStart',
		'SessionEnd',
		'Stop',
		'Notification'
	] as const;

	let activeEvent = $state<(typeof EVENTS)[number]>('PreToolUse');

	let matchers = $derived(value?.[activeEvent] ?? []);

	function commit(nextMatchers: AgentHookMatcher[]) {
		const next = { ...(value ?? {}) };
		if (nextMatchers.length === 0) delete next[activeEvent];
		else next[activeEvent] = nextMatchers;
		const hasAny = Object.keys(next).length > 0;
		onChange(hasAny ? next : undefined);
	}

	function addMatcher() {
		commit([
			...matchers,
			{
				matcher: '',
				hooks: [{ type: 'command', command: '' }]
			}
		]);
	}

	function removeMatcher(index: number) {
		commit(matchers.filter((_, i) => i !== index));
	}

	function updateMatcher(index: number, patch: Partial<AgentHookMatcher>) {
		commit(matchers.map((m, i) => (i === index ? { ...m, ...patch } : m)));
	}

	function addHook(matcherIndex: number) {
		const m = matchers[matcherIndex];
		updateMatcher(matcherIndex, {
			hooks: [...m.hooks, { type: 'command', command: '' }]
		});
	}

	function removeHook(matcherIndex: number, hookIndex: number) {
		const m = matchers[matcherIndex];
		updateMatcher(matcherIndex, {
			hooks: m.hooks.filter((_, i) => i !== hookIndex)
		});
	}

	function updateHook(
		matcherIndex: number,
		hookIndex: number,
		patch: Partial<AgentHookDefinition>
	) {
		const m = matchers[matcherIndex];
		updateMatcher(matcherIndex, {
			hooks: m.hooks.map((h, i) =>
				i === hookIndex ? ({ ...h, ...patch } as AgentHookDefinition) : h
			)
		});
	}

	function eventCount(event: string): number {
		return (value?.[event] ?? []).length;
	}
</script>

<div class="space-y-3">
	<p class="text-xs text-muted-foreground">
		Hooks run at agent lifecycle events. A hook returning exit code 2 blocks the action (e.g., denies
		a tool call). See docs/hooks-and-plugins.md.
	</p>

	<div class="flex flex-wrap gap-1 border-b pb-2">
		{#each EVENTS as event}
			{@const count = eventCount(event)}
			<button
				type="button"
				class="px-3 py-1 rounded text-xs {activeEvent === event
					? 'bg-primary text-primary-foreground'
					: 'hover:bg-muted'}"
				onclick={() => (activeEvent = event)}
			>
				{event}
				{#if count > 0}
					<Badge variant={activeEvent === event ? 'secondary' : 'outline'} class="ml-1">
						{count}
					</Badge>
				{/if}
			</button>
		{/each}
	</div>

	<div class="flex items-center justify-between">
		<p class="text-sm font-medium">{activeEvent} matchers</p>
		<Button size="sm" variant="outline" onclick={addMatcher}>
			<Plus class="size-3" /> Add matcher
		</Button>
	</div>

	{#if matchers.length === 0}
		<div class="rounded border border-dashed p-3 text-xs text-muted-foreground">
			No matchers yet. Add one to define hook behavior for this event.
		</div>
	{:else}
		<div class="space-y-3">
			{#each matchers as matcher, mi (mi)}
				<div class="rounded border p-3 space-y-3 bg-muted/20">
					<div class="flex items-start gap-2">
						<div class="flex-1 space-y-1">
							<Label class="text-[11px]">
								Matcher (e.g. <code>Bash</code>, <code>Read|Write</code>, blank = all)
							</Label>
							<Input
								value={matcher.matcher ?? ''}
								placeholder="all"
								oninput={(e) =>
									updateMatcher(mi, {
										matcher: (e.target as HTMLInputElement).value
									})}
							/>
						</div>
						<Button
							variant="ghost"
							size="icon"
							class="size-7 text-destructive"
							onclick={() => removeMatcher(mi)}
						>
							<Trash2 class="size-3" />
						</Button>
					</div>

					<div class="space-y-2">
						{#each matcher.hooks as hook, hi (hi)}
							<div class="rounded border bg-background p-2 space-y-2">
								<div class="flex items-center gap-2">
									<select
										class="rounded-md border bg-background px-2 py-1 text-xs"
										value={hook.type}
										onchange={(e) =>
											updateHook(mi, hi, {
												type: (e.target as HTMLSelectElement).value as 'command' | 'callback'
											})}
									>
										<option value="command">command</option>
										<option value="callback">callback</option>
									</select>
									<Input
										class="flex-1 text-xs"
										placeholder="condition (optional) e.g. Bash(rm *)"
										value={hook.if ?? ''}
										oninput={(e) =>
											updateHook(mi, hi, {
												if: (e.target as HTMLInputElement).value || undefined
											})}
									/>
									<Button
										variant="ghost"
										size="icon"
										class="size-6 text-destructive"
										onclick={() => removeHook(mi, hi)}
									>
										<Trash2 class="size-3" />
									</Button>
								</div>
								{#if hook.type === 'command'}
									<Textarea
										rows={2}
										class="font-mono text-xs"
										placeholder="/bin/sh -c 'echo denied >&2; exit 2'"
										value={hook.command}
										oninput={(e) =>
											updateHook(mi, hi, {
												command: (e.target as HTMLTextAreaElement).value
											})}
									/>
									<Input
										type="number"
										class="text-xs"
										placeholder="timeout (seconds)"
										value={hook.timeout ?? ''}
										oninput={(e) => {
											const v = (e.target as HTMLInputElement).value;
											updateHook(mi, hi, {
												timeout: v ? Number(v) : undefined
											});
										}}
									/>
								{:else}
									<Input
										class="font-mono text-xs"
										placeholder="module.callback_name"
										value={hook.callback ?? ''}
										oninput={(e) =>
											updateHook(mi, hi, {
												callback: (e.target as HTMLInputElement).value
											})}
									/>
								{/if}
							</div>
						{/each}
						<Button size="sm" variant="ghost" onclick={() => addHook(mi)}>
							<Plus class="size-3" /> Add hook action
						</Button>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
