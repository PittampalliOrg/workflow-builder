<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { NativeSelect } from '$lib/components/ui/native-select';

	interface Props {
		data: Record<string, unknown>;
		onUpdate: (key: string, value: unknown) => void;
	}

	let { data, onUpdate }: Props = $props();

	let taskConfig = $derived((data.taskConfig as Record<string, unknown>) || {});
	let duration = $derived((taskConfig.duration as string) || '');

	// Parse ISO 8601 duration or plain seconds
	let durationMode = $state<'iso' | 'simple'>('simple');
	let simpleValue = $state('');
	let simpleUnit = $state<'seconds' | 'minutes' | 'hours'>('seconds');

	// Initialize local form state from duration prop (effect is correct here — these
	// values are also edited by the user, so $derived would cause form reset on each keystroke)
	$effect(() => {
		const d = duration;
		if (!d) {
			simpleValue = '';
			simpleUnit = 'seconds';
			durationMode = 'simple';
			return;
		}
		// Try to parse as ISO 8601
		const isoMatch = d.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
		if (isoMatch) {
			const hours = parseInt(isoMatch[1] || '0');
			const minutes = parseInt(isoMatch[2] || '0');
			const seconds = parseInt(isoMatch[3] || '0');
			if (hours > 0 && minutes === 0 && seconds === 0) {
				simpleValue = String(hours);
				simpleUnit = 'hours';
				durationMode = 'simple';
			} else if (minutes > 0 && hours === 0 && seconds === 0) {
				simpleValue = String(minutes);
				simpleUnit = 'minutes';
				durationMode = 'simple';
			} else if (hours === 0 && minutes === 0) {
				simpleValue = String(seconds);
				simpleUnit = 'seconds';
				durationMode = 'simple';
			} else {
				durationMode = 'iso';
			}
		} else if (/^\d+$/.test(d)) {
			simpleValue = d;
			simpleUnit = 'seconds';
			durationMode = 'simple';
		} else {
			durationMode = 'iso';
		}
	});

	function updateDuration(value: string) {
		onUpdate('taskConfig', { ...taskConfig, duration: value });
	}

	function updateSimple() {
		const v = parseInt(simpleValue) || 0;
		if (v <= 0) {
			updateDuration('');
			return;
		}
		switch (simpleUnit) {
			case 'hours':
				updateDuration(`PT${v}H`);
				break;
			case 'minutes':
				updateDuration(`PT${v}M`);
				break;
			case 'seconds':
			default:
				updateDuration(`PT${v}S`);
				break;
		}
	}
</script>

<div class="space-y-4">
	<div class="space-y-1.5">
		<Label>Duration Mode</Label>
		<div class="flex gap-2">
			<Button
				variant={durationMode === 'simple' ? 'default' : 'outline'}
				size="sm"
				onclick={() => (durationMode = 'simple')}
			>
				Simple
			</Button>
			<Button
				variant={durationMode === 'iso' ? 'default' : 'outline'}
				size="sm"
				onclick={() => (durationMode = 'iso')}
			>
				ISO 8601
			</Button>
		</div>
	</div>

	{#if durationMode === 'simple'}
		<div class="flex gap-2">
			<div class="flex-1 space-y-1.5">
				<Label for="wait-value">Value</Label>
				<Input
					id="wait-value"
					type="number"
					min="0"
					value={simpleValue}
					oninput={(e) => {
						simpleValue = e.currentTarget.value;
						updateSimple();
					}}
					placeholder="30"
				/>
			</div>
			<div class="w-28 space-y-1.5">
				<Label for="wait-unit">Unit</Label>
				<NativeSelect
					class="w-full"
					id="wait-unit"
					value={simpleUnit}
					onchange={(e) => {
						simpleUnit = e.currentTarget.value as 'seconds' | 'minutes' | 'hours';
						updateSimple();
					}}
				>
					<option value="seconds">Seconds</option>
					<option value="minutes">Minutes</option>
					<option value="hours">Hours</option>
				</NativeSelect>
			</div>
		</div>
	{:else}
		<div class="space-y-1.5">
			<Label for="iso-duration">ISO 8601 Duration</Label>
			<Input
				id="iso-duration"
				type="text"
				value={duration}
				oninput={(e) => updateDuration(e.currentTarget.value)}
				placeholder="PT30S, PT5M, PT1H30M"
			/>
			<p class="mt-1 text-[10px] text-muted-foreground">
				Format: PT[hours]H[minutes]M[seconds]S (e.g., PT1H30M, PT45S)
			</p>
		</div>
	{/if}

	{#if duration}
		<div>
			<span class="text-xs text-muted-foreground">Current:</span>
			<code class="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs">{duration}</code>
		</div>
	{/if}
</div>
