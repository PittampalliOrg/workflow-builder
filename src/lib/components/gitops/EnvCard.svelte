<script lang="ts">
	import {
		AlertTriangle,
		CheckCircle2,
		CircleSlash,
		Clock3,
		HardDrive,
		Package,
	} from "lucide-svelte";

	import { Badge } from "$lib/components/ui/badge";
	import type { EnvCell, EnvName, SpecialCase } from "$lib/gitops/service-matrix";
	import {
		driftLabel,
		driftVariant,
		relativeTime,
		shortImage,
		shortSha,
		statusVariant,
	} from "$lib/utils/gitops-display";

	type Props = {
		env: EnvName;
		cell: EnvCell | null;
		specialCase: SpecialCase;
	};

	let { env, cell, specialCase }: Props = $props();

	const envLabel = $derived(env);
	const envColor = $derived(
		env === "ryzen"
			? "text-sky-600 dark:text-sky-400"
			: env === "dev"
				? "text-amber-600 dark:text-amber-400"
				: "text-emerald-600 dark:text-emerald-400",
	);

	const ghUrl = $derived(
		cell?.commitSha
			? `https://github.com/PittampalliOrg/workflow-builder/commit/${cell.commitSha}`
			: null,
	);

	const emptyReason = $derived.by(() => {
		if (cell) return null;
		if (specialCase === "ryzen-only" && env !== "ryzen") {
			return "not deployed on this env (ryzen-only)";
		}
		if (specialCase === "sandbox-only" && env === "ryzen") {
			return "runtime-launched, not deployed on ryzen";
		}
		if (specialCase === "ryzen-missing-pin" && env === "ryzen") {
			return "no ryzen kustomization pin";
		}
		return "no inventory data for this env";
	});

	const isPinOnly = $derived(cell?.source === "pin-only");
	const isLiveOnly = $derived(cell?.source === "live-only");

	const healthIcon = $derived.by(() => {
		if (!cell || cell.source !== "inventory") return null;
		const sync = cell.syncStatus;
		const health = cell.healthStatus;
		if (sync === "Synced" && health === "Healthy") return CheckCircle2;
		if (sync === "OutOfSync" || health === "Degraded") return AlertTriangle;
		return Clock3;
	});
</script>

<div
	class="flex min-w-[14rem] max-w-[18rem] flex-col gap-1.5 rounded-lg border p-3 text-xs shadow-sm {cell
		? 'bg-card'
		: 'bg-muted/30 border-dashed'}"
>
	<div class="flex items-center justify-between gap-1">
		<div class="flex items-center gap-1 font-semibold uppercase tracking-wide {envColor}">
			<HardDrive class="size-3" />
			{envLabel}
		</div>
		{#if isPinOnly}
			<Badge variant="outline" class="text-[0.65rem]" title="Image tag from release-pins; no live Deployment to reconcile">
				<Package class="size-3" />
				pin only
			</Badge>
		{:else if isLiveOnly}
			<Badge variant="outline" class="text-[0.65rem]" title="Read from local Kubernetes Deployment; no hub inventory entry">
				<HardDrive class="size-3" />
				live
			</Badge>
		{:else if specialCase === "single-source" && cell}
			<Badge variant="outline" class="text-[0.65rem]" title="agent-runtime-controller is bumped directly in base manifests; all envs share the same image">
				single-source
			</Badge>
		{/if}
	</div>

	{#if !cell}
		<div class="flex min-h-[3rem] items-center gap-1.5 text-muted-foreground">
			<CircleSlash class="size-3.5" />
			<span class="text-[0.7rem]">{emptyReason}</span>
		</div>
	{:else}
		<div class="min-w-0 font-mono text-[0.75rem]" title={cell.tag ?? cell.liveImage ?? ""}>
			{cell.tag ?? (cell.liveImage ? shortImage(cell.liveImage) : "—")}
		</div>

		{#if cell.source === "inventory"}
			<div class="flex flex-wrap items-center gap-1">
				{#if healthIcon}
					{@const HealthIcon = healthIcon}
					<HealthIcon class="size-3 text-muted-foreground" />
				{/if}
				<Badge variant={statusVariant(cell.syncStatus)} class="text-[0.65rem]">
					{cell.syncStatus ?? "Unknown"}
				</Badge>
				<Badge variant={statusVariant(cell.healthStatus)} class="text-[0.65rem]">
					{cell.healthStatus ?? "Unknown"}
				</Badge>
			</div>

			{#if cell.driftStatus}
				<div>
					<Badge variant={driftVariant(cell.driftStatus)} class="text-[0.65rem]">
						{driftLabel(cell.driftStatus)}
					</Badge>
				</div>
			{/if}
		{:else if cell.source === "live-only"}
			<div class="flex flex-wrap items-center gap-1">
				<Badge variant={statusVariant(cell.healthStatus)} class="text-[0.65rem]">
					{cell.healthStatus ?? "Unknown"}
				</Badge>
				{#if cell.driftStatus}
					<Badge variant={driftVariant(cell.driftStatus)} class="text-[0.65rem]">
						{driftLabel(cell.driftStatus)}
					</Badge>
				{/if}
			</div>
		{/if}

		<div class="mt-auto flex items-center justify-between gap-1 text-[0.66rem] text-muted-foreground">
			<span title={cell.commitSha ?? ""}>
				{#if ghUrl}
					<a class="font-mono text-primary hover:underline" href={ghUrl} target="_blank" rel="noreferrer">
						{shortSha(cell.commitSha)}
					</a>
				{:else}
					<span class="font-mono">{shortSha(cell.commitSha)}</span>
				{/if}
			</span>
			<span>{relativeTime(cell.updatedAt)}</span>
		</div>
	{/if}
</div>
