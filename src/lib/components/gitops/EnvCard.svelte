<script lang="ts">
	import {
		AlertTriangle,
		CheckCircle2,
		CircleSlash,
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
		shortTag,
		statusVariant,
	} from "$lib/utils/gitops-display";

	type Props = {
		env: EnvName;
		cell: EnvCell | null;
		specialCase: SpecialCase;
	};

	let { env, cell, specialCase }: Props = $props();

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
			return "not deployed on this env";
		}
		if (specialCase === "sandbox-only" && env === "ryzen") {
			return "runtime-launched";
		}
		if (specialCase === "ryzen-missing-pin" && env === "ryzen") {
			return "no ryzen pin";
		}
		return "no inventory data";
	});

	const isPinOnly = $derived(cell?.source === "pin-only");
	const isLiveOnly = $derived(cell?.source === "live-only");

	const displayTag = $derived(cell ? shortTag(cell.tag) : "—");
	const hasBothGreen = $derived(
		cell?.source === "inventory" &&
			cell.syncStatus === "Synced" &&
			(cell.healthStatus === "Healthy" || cell.healthStatus === "Succeeded"),
	);

	const showDrift = $derived(
		!!cell &&
			cell.driftStatus != null &&
			cell.driftStatus !== "in_sync",
	);

	const rowHasIssue = $derived(
		!!cell &&
			(cell.syncStatus === "OutOfSync" ||
				cell.healthStatus === "Degraded" ||
				cell.driftStatus === "pending_rollout"),
	);

	const StatusIcon = $derived(
		rowHasIssue ? AlertTriangle : hasBothGreen ? CheckCircle2 : null,
	);
</script>

<div
	class="group flex min-w-[11rem] flex-1 flex-col gap-1.5 rounded-lg border p-2.5 text-xs shadow-sm snap-start {cell
		? 'bg-card'
		: 'border-dashed bg-muted/30'}"
>
	<div class="flex items-center justify-between gap-1">
		<div class="flex items-center gap-1 text-[0.66rem] font-semibold uppercase tracking-wide {envColor}">
			<HardDrive class="size-3" />
			{env}
		</div>
		{#if isPinOnly}
			<Badge
				variant="outline"
				class="h-4 px-1 text-[0.6rem]"
				title="Image tag from release-pins; no live Deployment to reconcile"
			>
				<Package class="size-3" />
				pin
			</Badge>
		{:else if isLiveOnly}
			<Badge
				variant="outline"
				class="h-4 px-1 text-[0.6rem]"
				title="Read from local Kubernetes Deployment; no hub inventory entry"
			>
				live
			</Badge>
		{:else if specialCase === "single-source" && cell}
			<Badge variant="outline" class="h-4 px-1 text-[0.6rem]" title="agent-runtime-controller is bumped directly in base manifests">
				single
			</Badge>
		{/if}
	</div>

	{#if !cell}
		<div class="flex min-h-[2.5rem] items-center gap-1.5 text-muted-foreground">
			<CircleSlash class="size-3.5 shrink-0" />
			<span class="text-[0.7rem]">{emptyReason}</span>
		</div>
	{:else}
		<div
			class="truncate font-mono text-[0.8rem] leading-tight"
			title={cell.tag ?? cell.liveImage ?? ""}
		>
			{displayTag}
		</div>

		{#if cell.source === "inventory"}
			<div class="flex flex-wrap items-center gap-1">
				{#if StatusIcon}
					<StatusIcon
						class={rowHasIssue
							? "size-3 text-destructive"
							: "size-3 text-emerald-500"}
					/>
				{/if}
				{#if hasBothGreen}
					<Badge variant="secondary" class="h-4 px-1.5 text-[0.65rem]">
						Synced · Healthy
					</Badge>
				{:else}
					<Badge variant={statusVariant(cell.syncStatus)} class="h-4 px-1.5 text-[0.65rem]">
						{cell.syncStatus ?? "Unknown"}
					</Badge>
					<Badge variant={statusVariant(cell.healthStatus)} class="h-4 px-1.5 text-[0.65rem]">
						{cell.healthStatus ?? "Unknown"}
					</Badge>
				{/if}
				{#if showDrift}
					<Badge variant={driftVariant(cell.driftStatus)} class="h-4 px-1.5 text-[0.65rem]">
						{driftLabel(cell.driftStatus)}
					</Badge>
				{/if}
			</div>
		{:else if cell.source === "live-only"}
			<div class="flex flex-wrap items-center gap-1">
				<Badge variant={statusVariant(cell.healthStatus)} class="h-4 px-1.5 text-[0.65rem]">
					{cell.healthStatus ?? "Unknown"}
				</Badge>
				{#if showDrift}
					<Badge variant={driftVariant(cell.driftStatus)} class="h-4 px-1.5 text-[0.65rem]">
						{driftLabel(cell.driftStatus)}
					</Badge>
				{/if}
			</div>
		{/if}

		<div class="mt-auto flex items-center justify-between gap-1 text-[0.66rem] text-muted-foreground">
			<span class="truncate" title={cell.liveImage ?? ""}>
				{cell.liveImage ? shortImage(cell.liveImage) : ""}
			</span>
			<span class="flex shrink-0 items-center gap-1.5">
				<span>{relativeTime(cell.updatedAt)}</span>
				{#if ghUrl}
					<a
						class="font-mono text-primary opacity-0 transition-opacity hover:underline group-hover:opacity-100"
						href={ghUrl}
						target="_blank"
						rel="noreferrer"
						title={`commit ${cell.commitSha}`}
					>
						{shortSha(cell.commitSha)}
					</a>
				{/if}
			</span>
		</div>
	{/if}
</div>
