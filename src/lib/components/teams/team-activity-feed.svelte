<!--
  Unified team activity timeline: task claims/completions + message traffic
  merged reverse-chronologically, with member-identity color chips. The single
  "what is the team doing" feed shared by every TeamPulse surface.
-->
<script lang="ts">
	import { fly } from 'svelte/transition';
	import { CircleDot, CheckCircle2, MessageSquare, Megaphone, Bot, TriangleAlert } from '@lucide/svelte';
	import { memberColor } from './member-color';

	type Activity = {
		ts: string;
		kind: 'claimed' | 'completed';
		taskId: string;
		taskTitle: string;
		memberName: string | null;
	};
	type Msg = {
		ts: string;
		from: string | null;
		to: string | null;
		toSessionId: string;
		kind: string;
		preview: string | null;
	};

	interface Props {
		activity?: Activity[];
		recentMessages?: Msg[];
		maxItems?: number;
		class?: string;
	}
	let { activity = [], recentMessages = [], maxItems = 20, class: klass = '' }: Props = $props();

	type FeedItem =
		| { key: string; ts: string; type: 'task'; a: Activity }
		| { key: string; ts: string; type: 'msg'; m: Msg };

	const items = $derived.by<FeedItem[]>(() => {
		const out: FeedItem[] = [
			...activity.map((a): FeedItem => ({ key: `t:${a.taskId}:${a.kind}`, ts: a.ts, type: 'task', a })),
			...recentMessages
				.filter((m) => m.kind !== 'team-idle') // internal nudges stay out of the story
				.map((m): FeedItem => ({ key: `m:${m.ts}:${m.toSessionId}`, ts: m.ts, type: 'msg', m }))
		];
		out.sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0));
		return out.slice(0, maxItems);
	});

	let now = $state(Date.now());
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});
	function ago(ts: string): string {
		const ms = now - new Date(ts).getTime();
		if (!Number.isFinite(ms) || ms < 0) return 'just now';
		const s = Math.round(ms / 1000);
		if (s < 60) return `${s}s ago`;
		const m = Math.round(s / 60);
		if (m < 60) return `${m}m ago`;
		const h = Math.round(m / 60);
		if (h < 24) return `${h}h ago`;
		return `${Math.round(h / 24)}d ago`;
	}
</script>

{#snippet chip(name: string | null)}
	{@const c = memberColor(name)}
	<span class="inline-flex items-center gap-1 font-medium {c.text}">
		<span class="size-1.5 rounded-full {c.dot}"></span>{name ?? 'someone'}
	</span>
{/snippet}

<div class="space-y-1.5 {klass}" data-testid="team-activity-feed">
	{#each items as item (item.key)}
		<div class="flex items-start gap-2 text-xs" transition:fly={{ y: -6, duration: 200 }}>
			{#if item.type === 'task'}
				{#if item.a.kind === 'completed'}
					<CheckCircle2 class="mt-0.5 size-3 shrink-0 text-emerald-400" />
				{:else}
					<CircleDot class="mt-0.5 size-3 shrink-0 text-sky-400" />
				{/if}
				<span class="min-w-0 flex-1 leading-snug">
					{@render chip(item.a.memberName)}
					{item.a.kind === 'completed' ? ' completed ' : ' claimed '}
					<span class="text-muted-foreground">{item.a.taskTitle}</span>
					<span class="whitespace-nowrap text-muted-foreground/60"> · {ago(item.ts)}</span>
				</span>
			{:else}
				{#if item.m.kind === 'team-error'}
					<TriangleAlert class="mt-0.5 size-3 shrink-0 text-red-400" />
				{:else if item.m.kind === 'team-broadcast'}
					<Megaphone class="mt-0.5 size-3 shrink-0 text-amber-400" />
				{:else}
					<MessageSquare class="mt-0.5 size-3 shrink-0 {memberColor(item.m.from).text}" />
				{/if}
				<span class="min-w-0 flex-1 leading-snug">
					{@render chip(item.m.from)}
					{#if item.m.kind === 'team-error'}
						<span class="font-medium text-red-300"> failed</span>
					{:else if item.m.kind === 'team-broadcast'}
						<span> broadcast</span>
					{:else}
						<span> → </span>{@render chip(item.m.to)}
					{/if}
					{#if item.m.preview}
						<span class="text-muted-foreground">: “{item.m.preview.slice(0, 80)}{item.m.preview.length > 80 ? '…' : ''}”</span>
					{/if}
					<span class="whitespace-nowrap text-muted-foreground/60"> · {ago(item.ts)}</span>
				</span>
			{/if}
		</div>
	{:else}
		<div class="flex items-center gap-2 px-1 py-2 text-xs italic text-muted-foreground/70">
			<Bot class="size-3.5" /> quiet so far — activity appears as the team works
		</div>
	{/each}
</div>
