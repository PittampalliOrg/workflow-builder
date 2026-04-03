<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';

	interface Props {
		data: Record<string, unknown>;
		onUpdate: (key: string, value: unknown) => void;
	}

	let { data, onUpdate }: Props = $props();

	let taskConfig = $derived((data.taskConfig as Record<string, unknown>) || {});
	let emit = $derived((taskConfig.emit as Record<string, unknown>) || {});
	let event = $derived((emit.event as Record<string, unknown>) || {});

	let eventType = $derived((event.type as string) || '');
	let eventData = $derived.by(() => {
		const d = event.data;
		if (d === undefined || d === null) return '';
		if (typeof d === 'string') return d;
		return JSON.stringify(d, null, 2);
	});

	function updateEmit(updates: Record<string, unknown>) {
		onUpdate('taskConfig', {
			...taskConfig,
			emit: {
				...emit,
				event: { ...event, ...updates }
			}
		});
	}

	function setEventType(value: string) {
		updateEmit({ type: value });
	}

	function setEventData(value: string) {
		try {
			updateEmit({ data: JSON.parse(value) });
		} catch {
			updateEmit({ data: value });
		}
	}
</script>

<div class="space-y-4">
	<div class="space-y-1.5">
		<Label for="event-type">Event Type</Label>
		<Input
			id="event-type"
			type="text"
			value={eventType}
			oninput={(e) => setEventType(e.currentTarget.value)}
			placeholder="com.example.event.occurred"
		/>
	</div>

	<div class="space-y-1.5">
		<Label for="event-data">Event Data (JSON)</Label>
		<Textarea
			id="event-data"
			value={eventData}
			oninput={(e) => setEventData(e.currentTarget.value)}
			placeholder={'{"key": "value"}'}
			rows={6}
		></Textarea>
	</div>

	<div class="space-y-1.5">
		<Label for="event-source">Source (optional)</Label>
		<Input
			id="event-source"
			type="text"
			value={(event.source as string) || ''}
			oninput={(e) => updateEmit({ source: e.currentTarget.value })}
			placeholder="https://example.com/source"
		/>
	</div>
</div>
