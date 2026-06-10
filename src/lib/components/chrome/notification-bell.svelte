<script lang="ts">
	import {
		AlertTriangle,
		ArrowRight,
		Bell,
		Check,
		Flame,
		Radio,
		Rocket,
		Settings,
		ShieldAlert,
		Trash2,
		X,
	} from "@lucide/svelte";
	import { goto } from "$app/navigation";
	import * as Popover from "$lib/components/ui/popover";
	import { ScrollArea } from "$lib/components/ui/scroll-area";
	import { Switch } from "$lib/components/ui/switch";
	import {
		deploymentNotifications as store,
		notificationTargetUrl,
		type GitOpsNotification,
		type NotificationKind,
	} from "$lib/stores/deployment-notifications.svelte";
	import {
		MUTABLE_NOTIFICATION_KINDS,
		NOTIFICATION_KIND_LABELS,
	} from "$lib/gitops/notification-prefs";
	import { relativeTime, shortTag } from "$lib/utils/gitops-display";

	let { collapsed = false }: { collapsed?: boolean } = $props();

	let open = $state(false);
	let prefsOpen = $state(false);
	// A render-time clock so relative labels are fresh each time the panel opens.
	let now = $state(Date.now());

	// `bind:open` already syncs the state; this is a pure side-effect callback.
	function onOpenChange(next: boolean) {
		if (next) {
			now = Date.now();
			store.markAllRead();
		} else {
			prefsOpen = false;
		}
	}

	function envDot(env: string): string {
		if (env === "dev") return "bg-sky-500";
		if (env === "ryzen") return "bg-rose-500";
		if (env === "staging") return "bg-amber-500";
		return "bg-muted-foreground";
	}

	const KIND_ICONS: Record<NotificationKind, typeof Rocket> = {
		deploy: Rocket,
		build_failed: Flame,
		degraded: ShieldAlert,
		promotion_stuck: AlertTriangle,
		stream_health: Radio,
	};

	function severityTint(n: GitOpsNotification): string {
		if (n.severity === "error") return "text-destructive";
		if (n.severity === "warning") return "text-amber-600 dark:text-amber-400";
		return "text-muted-foreground";
	}

	function rel(n: GitOpsNotification): string {
		return relativeTime(new Date(n.at).toISOString(), now);
	}

	function openTarget(n: GitOpsNotification) {
		open = false;
		void goto(notificationTargetUrl(n));
	}
</script>

<Popover.Root bind:open {onOpenChange}>
	<Popover.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				title={store.streamStalled
					? "GitOps notifications — event stream stalled"
					: "GitOps notifications"}
				class="relative flex h-8 items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground {collapsed
					? 'w-full justify-center px-0'
					: 'gap-2.5 px-2.5'}"
			>
				<span class="relative flex shrink-0 items-center justify-center">
					<Bell size={15} />
					{#if store.streamStalled}
						<!-- Stream silent past the heartbeat window: amber alarm even at 0 unread. -->
						<span
							class="absolute -right-1.5 -top-1.5 flex min-w-[14px] items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-semibold leading-[14px] text-amber-950"
						>
							{store.unread > 0 ? (store.unread > 9 ? "9+" : store.unread) : "!"}
						</span>
					{:else if store.unread > 0}
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
				<Bell size={13} class="text-muted-foreground" />
				Notifications
			</div>
			<div class="flex items-center gap-1">
				{#if store.notifications.length > 0}
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
				{/if}
				<button
					type="button"
					onclick={() => (prefsOpen = !prefsOpen)}
					title="Notification preferences"
					class="rounded px-1 py-0.5 text-muted-foreground transition hover:bg-accent/50 hover:text-foreground {prefsOpen ? 'bg-accent/50 text-foreground' : ''}"
				>
					<Settings size={11} />
				</button>
			</div>
		</div>

		{#if store.notifications.length === 0}
			<div class="px-3 py-6 text-center text-[0.7rem] text-muted-foreground">
				Nothing yet.<br />
				Deploys, build failures, degraded apps, and stuck promotions land here.
			</div>
		{:else}
			<ScrollArea class="max-h-80">
				<ul class="divide-y divide-border/60">
					{#each store.notifications as n (n.id)}
						{@const KindIcon = KIND_ICONS[n.kind] ?? Rocket}
						<li class="group flex items-start gap-2 px-3 py-2 {n.read ? '' : 'bg-primary/[0.04]'}">
							<KindIcon size={13} class="mt-1 shrink-0 {severityTint(n)}" />
							<button
								type="button"
								class="min-w-0 flex-1 text-left"
								onclick={() => openTarget(n)}
								title="Open in GitOps pipeline"
							>
								{#if n.component}
									<div class="flex items-center gap-1 text-[0.72rem] font-medium">
										<span class="truncate">{n.component}</span>
										<ArrowRight size={11} class="shrink-0 text-muted-foreground" />
										<span class="shrink-0 text-muted-foreground">{n.env}</span>
										<span class="size-1.5 shrink-0 rounded-full {envDot(n.env)}" title={n.env}></span>
										{#if n.kind !== "deploy"}
											<span class="shrink-0 {severityTint(n)}">· {n.title}</span>
										{/if}
									</div>
								{:else}
									<div class="text-[0.72rem] font-medium {severityTint(n)}">{n.title}</div>
								{/if}
								{#if n.kind === "deploy" && n.toTag}
									<div class="truncate font-mono text-[0.64rem] text-muted-foreground" title={`${n.toTag}${n.fromTag ? ` (was ${n.fromTag})` : ""}`}>
										{shortTag(n.toTag)}{#if n.fromTag}<span class="opacity-70"> · was {shortTag(n.fromTag)}</span>{/if}
									</div>
								{:else if n.detail}
									<div class="truncate text-[0.64rem] text-muted-foreground" title={n.detail}>
										{n.detail}
									</div>
								{/if}
							</button>
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

		{#if prefsOpen}
			<div class="border-t border-border px-3 py-2">
				<div class="pb-1 text-[0.62rem] font-semibold uppercase tracking-wide text-muted-foreground">
					Notify me about
				</div>
				{#each MUTABLE_NOTIFICATION_KINDS as kind (kind)}
					<label class="flex items-center justify-between gap-2 py-1 text-[0.7rem]">
						<span>{NOTIFICATION_KIND_LABELS[kind]}</span>
						<Switch
							checked={!store.prefs.muted[kind]}
							onCheckedChange={(v) => store.setMuted(kind, !v)}
						/>
					</label>
				{/each}
				<div class="pt-1 text-[0.6rem] text-muted-foreground">
					Stream-health alarms can't be muted.
				</div>
			</div>
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
