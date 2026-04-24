<script lang="ts">
	import { Eye, EyeOff, Search } from "lucide-svelte";

	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import type { EnvName } from "$lib/gitops/service-matrix";

	export type StatusFilter = "all" | "attention" | "healthy" | "sandbox";

	type Props = {
		search: string;
		statusFilter: StatusFilter;
		envsVisible: Record<EnvName, boolean>;
		total: number;
		filtered: number;
		onSearchChange: (value: string) => void;
		onStatusFilterChange: (value: StatusFilter) => void;
		onEnvToggle: (env: EnvName) => void;
	};

	let {
		search,
		statusFilter,
		envsVisible,
		total,
		filtered,
		onSearchChange,
		onStatusFilterChange,
		onEnvToggle,
	}: Props = $props();

	const statuses: Array<{ id: StatusFilter; label: string }> = [
		{ id: "all", label: "All" },
		{ id: "attention", label: "Needs attention" },
		{ id: "healthy", label: "Healthy" },
		{ id: "sandbox", label: "Sandbox" },
	];

	const envs: EnvName[] = ["ryzen", "dev", "staging"];

	const envColor = (env: EnvName) =>
		env === "ryzen"
			? "text-sky-600 dark:text-sky-400"
			: env === "dev"
				? "text-amber-600 dark:text-amber-400"
				: "text-emerald-600 dark:text-emerald-400";
</script>

<div class="flex flex-wrap items-center gap-2 rounded-lg border bg-card/40 p-2">
	<div class="relative flex-1 min-w-[10rem] max-w-[18rem]">
		<Search class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
		<Input
			class="h-8 pl-7 text-xs"
			placeholder="Filter services…"
			value={search}
			oninput={(e) => onSearchChange(e.currentTarget.value)}
		/>
	</div>

	<div class="flex flex-wrap items-center gap-1">
		{#each statuses as item (item.id)}
			<Button
				size="sm"
				variant={statusFilter === item.id ? "default" : "outline"}
				class="h-7 px-2 text-[0.7rem]"
				onclick={() => onStatusFilterChange(item.id)}
			>
				{item.label}
			</Button>
		{/each}
	</div>

	<div class="flex items-center gap-1">
		<span class="hidden text-[0.65rem] text-muted-foreground sm:inline">columns:</span>
		{#each envs as env (env)}
			<Button
				size="sm"
				variant={envsVisible[env] ? "default" : "outline"}
				class="h-7 gap-1 px-2 text-[0.7rem] {envsVisible[env] ? envColor(env) : ''}"
				onclick={() => onEnvToggle(env)}
				title={envsVisible[env] ? `Hide ${env} column` : `Show ${env} column`}
			>
				{#if envsVisible[env]}
					<Eye class="size-3" />
				{:else}
					<EyeOff class="size-3" />
				{/if}
				{env}
			</Button>
		{/each}
	</div>

	<div class="ml-auto flex items-center gap-1 text-[0.7rem] text-muted-foreground">
		<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem]">
			{filtered}/{total}
		</Badge>
		<span>services</span>
	</div>
</div>
