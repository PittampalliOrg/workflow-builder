<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import {
		Collapsible,
		CollapsibleContent,
		CollapsibleTrigger
	} from '$lib/components/ui/collapsible';
	import {
		ChevronDown,
		ChevronRight,
		Container,
		Cpu,
		HardDrive,
		Network,
		Package,
		Settings
	} from 'lucide-svelte';
	import type { EnvironmentDetail } from '$lib/types/environments';

	interface Props {
		env: EnvironmentDetail;
	}
	const { env }: Props = $props();

	const cfg = $derived(env.config);

	let packagesOpen = $state(false);
	let hostsOpen = $state(true);

	function formatTtl(sec: number | undefined): string {
		if (!sec) return 'forever';
		if (sec < 60) return `${sec}s`;
		if (sec < 3600) return `${Math.floor(sec / 60)}m`;
		if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
		return `${Math.floor(sec / 86400)}d`;
	}

	function formatLimit(value: number | undefined, unit: string): string {
		if (!value) return '—';
		return `${value.toLocaleString()}${unit}`;
	}
</script>

<div class="space-y-6">
	<!-- Sandbox image -->
	<section class="space-y-2">
		<h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
			Sandbox image
		</h3>
		<div class="rounded border bg-muted/20 p-3 space-y-2">
			<div class="flex items-center gap-2">
				<Container class="size-4 text-muted-foreground" />
				<code class="text-sm font-mono">{env.slug}</code>
				{#if env.isBuiltin}
					<Badge variant="outline" class="text-[10px]">built-in</Badge>
				{/if}
			</div>
			{#if env.baseEnvSlug}
				<div class="text-[11px] text-muted-foreground">
					Inherits from <code class="font-mono">{env.baseEnvSlug}</code>
				</div>
			{/if}
			<div class="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
				<Badge variant="outline" class="text-[10px] gap-1">
					<Settings class="size-2.5" />
					mode: {cfg.sandboxMode}
				</Badge>
				<Badge variant="outline" class="text-[10px]">
					{cfg.keepAfterRun ? 'keep after run' : 'cleaned after run'}
				</Badge>
				{#if cfg.ttlSeconds}
					<Badge variant="outline" class="text-[10px]">
						TTL: {formatTtl(cfg.ttlSeconds)}
					</Badge>
				{/if}
				{#if env.build?.lastBuildStatus}
					<Badge
						variant={env.build.lastBuildStatus === 'built'
							? 'secondary'
							: env.build.lastBuildStatus === 'failed'
								? 'destructive'
								: 'outline'}
						class="text-[10px]"
					>
						{env.build.lastBuildStatus}
					</Badge>
				{/if}
			</div>
			{#if env.build?.imageTag}
				<div class="font-mono text-[10px] text-muted-foreground truncate">
					{env.build.imageTag}
				</div>
			{/if}
		</div>
	</section>

	<!-- Networking -->
	<section class="space-y-2">
		<h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
			Networking
		</h3>
		<div class="rounded border bg-muted/20 p-3 space-y-2">
			<div class="flex items-center gap-2">
				<Network class="size-4 text-muted-foreground" />
				{#if cfg.networking.type === 'unrestricted'}
					<span class="text-sm">Unrestricted</span>
					<Badge variant="outline" class="text-[10px] bg-amber-500/15 text-amber-400 border-transparent">
						full egress
					</Badge>
				{:else}
					<span class="text-sm">Allowed hosts only</span>
					<Badge variant="outline" class="text-[10px] bg-green-600/15 text-green-700 dark:text-green-400 border-transparent">
						limited
					</Badge>
				{/if}
			</div>
			{#if cfg.networking.type === 'limited'}
				{@const allowed = cfg.networking.allowedHosts ?? []}
				{#if allowed.length > 0}
					<Collapsible bind:open={hostsOpen}>
						<CollapsibleTrigger>
							{#snippet child({ props })}
								<Button
									{...props}
									variant="ghost"
									size="sm"
									class="h-6 gap-1 px-0 text-[11px] text-muted-foreground hover:text-foreground"
								>
									{#if hostsOpen}
										<ChevronDown class="size-3" />
									{:else}
										<ChevronRight class="size-3" />
									{/if}
									{allowed.length} allowed host{allowed.length === 1 ? '' : 's'}
								</Button>
							{/snippet}
						</CollapsibleTrigger>
						<CollapsibleContent>
							<ul class="mt-1 space-y-0.5 rounded border bg-background/40 p-2 font-mono text-[11px]">
								{#each allowed as host (host)}
									<li>{host}</li>
								{/each}
							</ul>
						</CollapsibleContent>
					</Collapsible>
				{/if}
			{/if}
		</div>
	</section>

	<!-- Packages -->
	{#if cfg.packages && Object.values(cfg.packages).some((v) => Array.isArray(v) && v.length > 0)}
		{@const flatPkgs = Object.entries(cfg.packages).flatMap(([manager, specs]) =>
			(specs ?? []).map((spec) => ({ manager, spec }))
		)}
		<section class="space-y-2">
			<h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
				Packages
			</h3>
			<Collapsible bind:open={packagesOpen}>
				<div class="rounded border bg-muted/20">
					<CollapsibleTrigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="ghost"
								class="h-auto w-full justify-between rounded-none px-3 py-2"
							>
								<span class="flex items-center gap-2 text-sm">
									<Package class="size-4 text-muted-foreground" />
									{flatPkgs.length} package{flatPkgs.length === 1 ? '' : 's'}
								</span>
								{#if packagesOpen}
									<ChevronDown class="size-3" />
								{:else}
									<ChevronRight class="size-3" />
								{/if}
							</Button>
						{/snippet}
					</CollapsibleTrigger>
					<CollapsibleContent>
						<ul class="divide-y border-t">
							{#each flatPkgs as pkg (pkg.manager + ':' + pkg.spec)}
								<li class="px-3 py-1.5 font-mono text-[11px]">
									<span class="text-muted-foreground">{pkg.manager}</span>
									<span class="mx-1 text-muted-foreground/50">›</span>
									{pkg.spec}
								</li>
							{/each}
						</ul>
					</CollapsibleContent>
				</div>
			</Collapsible>
		</section>
	{/if}

	<!-- Resource limits -->
	{#if cfg.resourceLimits}
		<section class="space-y-2">
			<h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
				Resource limits
			</h3>
			<div class="grid grid-cols-3 gap-2">
				<div class="rounded border bg-muted/20 p-3">
					<div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
						<Cpu class="size-3" /> CPU
					</div>
					<div class="mt-1 font-mono text-sm">
						{formatLimit(cfg.resourceLimits.cpuMillicores, 'm')}
					</div>
				</div>
				<div class="rounded border bg-muted/20 p-3">
					<div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
						<HardDrive class="size-3" /> Memory
					</div>
					<div class="mt-1 font-mono text-sm">
						{formatLimit(cfg.resourceLimits.memoryMb, ' MB')}
					</div>
				</div>
				<div class="rounded border bg-muted/20 p-3">
					<div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
						<HardDrive class="size-3" /> Disk
					</div>
					<div class="mt-1 font-mono text-sm">
						{formatLimit(cfg.resourceLimits.diskMb, ' MB')}
					</div>
				</div>
			</div>
		</section>
	{/if}

	<!-- Version -->
	<section class="space-y-2">
		<h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
			Metadata
		</h3>
		<dl class="rounded border bg-muted/20 p-3 text-[11px] space-y-1.5">
			<div class="flex justify-between gap-3">
				<dt class="text-muted-foreground">Current version</dt>
				<dd class="font-mono">v{env.currentVersion ?? '—'}</dd>
			</div>
			<div class="flex justify-between gap-3">
				<dt class="text-muted-foreground">Slug</dt>
				<dd class="font-mono">{env.slug}</dd>
			</div>
			{#if env.usedByCount !== undefined}
				<div class="flex justify-between gap-3">
					<dt class="text-muted-foreground">Used by</dt>
					<dd>{env.usedByCount} agent{env.usedByCount === 1 ? '' : 's'}</dd>
				</div>
			{/if}
			<div class="flex justify-between gap-3">
				<dt class="text-muted-foreground">Updated</dt>
				<dd>{new Date(env.updatedAt).toLocaleString()}</dd>
			</div>
		</dl>
	</section>
</div>
