<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';
	import Bot from '@lucide/svelte/icons/bot';
	import Brain from '@lucide/svelte/icons/brain';
	import HardDriveDownload from '@lucide/svelte/icons/hard-drive-download';
	import HardDriveUpload from '@lucide/svelte/icons/hard-drive-upload';
	import Route from '@lucide/svelte/icons/route';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import Flag from '@lucide/svelte/icons/flag';
	import type { AgentStepType } from '$lib/types/agent-graph';

	interface Props {
		data: {
			label?: string;
			stepType?: AgentStepType;
			config?: Record<string, unknown>;
		};
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	type StepPresentation = {
		icon: typeof Bot;
		tint: string;
		chip: string;
	};

	const STEP_PRESENTATION: Record<AgentStepType, StepPresentation> = {
		input: { icon: Bot, tint: 'from-sky-500/20 to-cyan-500/10 text-sky-300', chip: 'Input' },
		decide: { icon: Brain, tint: 'from-amber-500/20 to-orange-500/10 text-amber-300', chip: 'Decision' },
		tool_batch: { icon: SquareTerminal, tint: 'from-emerald-500/20 to-teal-500/10 text-emerald-300', chip: 'Tools' },
		memory_read: { icon: HardDriveDownload, tint: 'from-violet-500/20 to-fuchsia-500/10 text-violet-300', chip: 'Memory' },
		memory_write: { icon: HardDriveUpload, tint: 'from-violet-500/20 to-fuchsia-500/10 text-violet-300', chip: 'Memory' },
		memory_compact: { icon: HardDriveUpload, tint: 'from-violet-500/20 to-fuchsia-500/10 text-violet-300', chip: 'Compaction' },
		approval_gate: { icon: Route, tint: 'from-rose-500/20 to-pink-500/10 text-rose-300', chip: 'Approval' },
		delegate: { icon: Route, tint: 'from-indigo-500/20 to-blue-500/10 text-indigo-300', chip: 'Delegate' },
		sleep: { icon: Route, tint: 'from-slate-500/20 to-slate-400/10 text-slate-300', chip: 'Timer' },
		finish: { icon: Flag, tint: 'from-lime-500/20 to-emerald-500/10 text-lime-300', chip: 'Finish' },
		plan: { icon: Brain, tint: 'from-amber-500/20 to-orange-500/10 text-amber-300', chip: 'Plan' }
	};

	const stepType = $derived((data.stepType as AgentStepType | undefined) ?? 'tool_batch');
	const presentation = $derived(STEP_PRESENTATION[stepType] ?? STEP_PRESENTATION.tool_batch);
	const configSummary = $derived.by(() => {
		const config = data.config ?? {};
		const keys = Object.keys(config).filter((key) => config[key] !== undefined && config[key] !== '');
		if (keys.length === 0) return 'No config';
		return keys.slice(0, 2).join(' • ');
	});
</script>

<div
	class={`group relative min-h-[92px] w-[220px] rounded-2xl border border-white/10 bg-slate-950/92 shadow-[0_20px_45px_-24px_rgba(15,23,42,0.85)] transition-all ${selected ? 'ring-2 ring-cyan-400/70 shadow-[0_30px_60px_-24px_rgba(34,211,238,0.25)]' : 'hover:border-white/20 hover:-translate-y-0.5 hover:shadow-[0_28px_56px_-24px_rgba(15,23,42,0.9)]'}`}
>
	<Handle
		type="target"
		position={Position.Top}
		class="!h-3 !w-3 !border-2 !border-slate-950 !bg-cyan-300"
	/>

	<div class="absolute inset-0 rounded-2xl bg-gradient-to-br {presentation.tint} opacity-90"></div>
	<div class="relative flex h-full flex-col justify-between gap-3 p-4">
		<div class="flex items-start justify-between gap-3">
			<div class="space-y-1">
				<p class="text-[11px] uppercase tracking-[0.18em] text-slate-400">{presentation.chip}</p>
				<p class="text-sm font-semibold leading-tight text-slate-50">{data.label ?? 'Loop Step'}</p>
			</div>
			<div class="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm">
				<svelte:component this={presentation.icon} size={18} class={presentation.tint.split(' ').at(-1) ?? 'text-slate-100'} />
			</div>
		</div>

		<div class="flex items-center justify-between gap-3">
			<p class="truncate text-[11px] text-slate-300/80">{configSummary}</p>
			<div class="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] font-medium text-slate-200/80">
				{stepType.replace('_', ' ')}
			</div>
		</div>
	</div>

	<Handle
		type="source"
		position={Position.Bottom}
		class="!h-3 !w-3 !border-2 !border-slate-950 !bg-cyan-300"
	/>
</div>
