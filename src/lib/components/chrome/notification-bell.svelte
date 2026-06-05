<script lang="ts">
	import { Bell, Check, Rocket, Trash2, X, ArrowRight } from "@lucide/svelte";
	import * as Popover from "$lib/components/ui/popover";
	import { ScrollArea } from "$lib/components/ui/scroll-area";
	import {
		deploymentNotifications as store,
		type DeployNotification,
	} from "$lib/stores/deployment-notifications.svelte";
	import { relativeTime, shortTag } from "$lib/utils/gitops-display";

	let { collapsed = false }: { collapsed?: boolean } = $props();

	let open = $state(false);
	// A render-time clock so relative labels are fresh each time the panel opens.
	let now = $state(Date.now());

	// `bind:open` already syncs the state; this is a pure side-effect callback.
	function onOpenChange(next: boolean) {
		if (next) {
			now = Date.now();
			store.markAllRead();
		}
	}

	function envDot(env: string): string {
		if (env === "dev") return "bg-sky-500";
		if (env === "ryzen") return "bg-rose-500";
		if (env === "staging") return "bg-amber-500";
		return "bg-muted-foreground";
	}

	function rel(n: DeployNotification): string {
		return relativeTime(new Date(n.at).toISOString(), now);
	}
</script>

<Popover.Root bind:open {onOpenChange}>
	<Popover.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				title="Deployment notifications"
				class="relative flex h-8 items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground {collapsed
					? 'w-full justify-center px-0'
					: 'gap-2.5 px-2.5'}"
			>
				<span class="relative flex shrink-0 items-center justify-center">
					<Bell size={15} />
					{#if store.unread > 0}
						<span
							class="absolute -right-1.5 -top-1.5 flex min-w-[14px] items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-[14px] text-primary-foreground"
						>
							{store.unread > 9 ? "9+" : store.unread}
						</span>
					{/if}
				</span>
				{#if !collapsed}
					<span class="flex-1 text-left text-xs">Notifications</span>
				{/if}
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		side={collapsed ? "right" : "top"}
		align="start"
		class="w-80 p-0"
	>
		<div class="flex items-center justify-between border-b border-border px-3 py-2">
			<div class="flex items-center gap-1.5 text-xs font-semibold">
				<Rocket size={13} class="text-muted-foreground" />
				Deployments
			</div>
			{#if store.notifications.length > 0}
				<div class="flex items-center gap-1">
					<button
						type="button"
						onclick={() => store.markAllRead()}
						title="Mark all read"
						class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.62rem] text-muted-foreground transition hover:bg-accent/50 hover:text-foreground"
					>
						<Check size={11} /> Read
					</button>
					<button
						type="button"
						onclick={() => store.clear()}
						title="Clear all"
						class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.62rem] text-muted-foreground transition hover:bg-accent/50 hover:text-foreground"
					>
						<Trash2 size={11} /> Clear
					</button>
				</div>
			{/if}
		</div>

		{#if store.notifications.length === 0}
			<div class="px-3 py-6 text-center text-[0.7rem] text-muted-foreground">
				No deployments yet.<br />
				You'll be notified when an image rolls out to a cluster.
			</div>
		{:else}
			<ScrollArea class="max-h-80">
				<ul class="divide-y divide-border/60">
					{#each store.notifications as n (n.id)}
						<li class="group flex items-start gap-2 px-3 py-2 {n.read ? '' : 'bg-primary/[0.04]'}">
							<span class="mt-1.5 size-2 shrink-0 rounded-full {envDot(n.env)}" title={n.env}></span>
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-1 text-[0.72rem] font-medium">
									<span class="truncate">{n.component}</span>
									<ArrowRight size={11} class="shrink-0 text-muted-foreground" />
									<span class="shrink-0 text-muted-foreground">{n.env}</span>
								</div>
								<div class="truncate font-mono text-[0.64rem] text-muted-foreground" title={`${n.toTag}${n.fromTag ? ` (was ${n.fromTag})` : ""}`}>
									{shortTag(n.toTag)}{#if n.fromTag}<span class="opacity-70"> · was {shortTag(n.fromTag)}</span>{/if}
								</div>
							</div>
							<div class="flex shrink-0 flex-col items-end gap-1">
								<span class="font-mono text-[0.56rem] text-muted-foreground" title={new Date(n.at).toLocaleString()}>
									{rel(n)}
								</span>
								<button
									type="button"
									onclick={() => store.dismiss(n.id)}
									title="Dismiss"
									class="text-muted-foreground/50 opacity-0 transition hover:text-foreground group-hover:opacity-100"
								>
									<X size={12} />
								</button>
							</div>
						</li>
					{/each}
				</ul>
			</ScrollArea>
		{/if}

		<a
			href="/admin/gitops/system"
			onclick={() => (open = false)}
			class="flex items-center justify-center gap-1 border-t border-border px-3 py-2 text-[0.66rem] font-medium text-primary transition hover:bg-accent/50"
		>
			Open GitOps pipeline <ArrowRight size={11} />
		</a>
	</Popover.Content>
</Popover.Root>
