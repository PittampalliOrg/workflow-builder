<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Textarea } from '$lib/components/ui/textarea';

	interface Props {
		data: Record<string, unknown>;
		onUpdate: (key: string, value: unknown) => void;
	}

	let { data, onUpdate }: Props = $props();

	let taskConfig = $derived((data.taskConfig as Record<string, unknown>) || {});
	let run = $derived((taskConfig.run as Record<string, unknown>) || {});

	// Determine run type from existing config
	let runType = $derived.by<'shell' | 'container' | 'workflow'>(() => {
		if (run.shell) return 'shell';
		if (run.container) return 'container';
		if (run.workflow) return 'workflow';
		return 'shell';
	});

	let shell = $derived((run.shell as Record<string, unknown>) || {});
	let container = $derived((run.container as Record<string, unknown>) || {});
	let workflow = $derived((run.workflow as Record<string, unknown>) || {});

	function updateRun(updates: Record<string, unknown>) {
		onUpdate('taskConfig', { ...taskConfig, run: { ...run, ...updates } });
	}

	function setRunType(type: string) {
		// Clear other types when switching
		const newRun: Record<string, unknown> = {};
		switch (type) {
			case 'shell':
				newRun.shell = shell.command ? shell : { command: '' };
				break;
			case 'container':
				newRun.container = container.image ? container : { image: '', command: '' };
				break;
			case 'workflow':
				newRun.workflow = workflow.id ? workflow : { id: '' };
				break;
		}
		onUpdate('taskConfig', { ...taskConfig, run: newRun });
	}

	function updateShell(updates: Record<string, unknown>) {
		updateRun({ shell: { ...shell, ...updates } });
	}

	function updateContainer(updates: Record<string, unknown>) {
		updateRun({ container: { ...container, ...updates } });
	}

	function updateWorkflow(updates: Record<string, unknown>) {
		updateRun({ workflow: { ...workflow, ...updates } });
	}
</script>

<div class="space-y-4">
	<div class="space-y-1.5">
		<Label for="run-type">Run Type</Label>
		<NativeSelect
			class="w-full"
			id="run-type"
			value={runType}
			onchange={(e) => setRunType(e.currentTarget.value)}
		>
			<option value="shell">Shell</option>
			<option value="container">Container</option>
			<option value="workflow">Workflow</option>
		</NativeSelect>
	</div>

	{#if runType === 'shell'}
		<div class="space-y-1.5">
			<Label for="shell-command">Shell Command</Label>
			<Textarea
				id="shell-command"
				value={(shell.command as string) || ''}
				oninput={(e) => updateShell({ command: e.currentTarget.value })}
				placeholder="echo 'Hello, World!'"
				rows={5}
			></Textarea>
		</div>
		<div class="space-y-1.5">
			<Label for="shell-env">Environment (optional JSON)</Label>
			<Textarea
				id="shell-env"
				value={shell.environment ? JSON.stringify(shell.environment, null, 2) : ''}
				oninput={(e) => {
					try {
						updateShell({ environment: JSON.parse(e.currentTarget.value) });
					} catch { /* ignore parse errors while typing */ }
				}}
				placeholder={'{"VAR": "value"}'}
				rows={3}
			></Textarea>
		</div>
	{:else if runType === 'container'}
		<div class="space-y-1.5">
			<Label for="container-image">Image</Label>
			<Input
				id="container-image"
				type="text"
				value={(container.image as string) || ''}
				oninput={(e) => updateContainer({ image: e.currentTarget.value })}
				placeholder="docker.io/library/alpine:latest"
			/>
		</div>
		<div class="space-y-1.5">
			<Label for="container-command">Command</Label>
			<Input
				id="container-command"
				type="text"
				value={(container.command as string) || ''}
				oninput={(e) => updateContainer({ command: e.currentTarget.value })}
				placeholder="/bin/sh -c 'echo hello'"
			/>
		</div>
		<div class="space-y-1.5">
			<Label for="container-ports">Ports (optional, comma-separated)</Label>
			<Input
				id="container-ports"
				type="text"
				value={(container.ports as string) || ''}
				oninput={(e) => updateContainer({ ports: e.currentTarget.value })}
				placeholder="8080:80, 443:443"
			/>
		</div>
		<div class="space-y-1.5">
			<Label for="container-env">Environment (optional JSON)</Label>
			<Textarea
				id="container-env"
				value={container.environment ? JSON.stringify(container.environment, null, 2) : ''}
				oninput={(e) => {
					try {
						updateContainer({ environment: JSON.parse(e.currentTarget.value) });
					} catch { /* ignore parse errors while typing */ }
				}}
				placeholder={'{"VAR": "value"}'}
				rows={3}
			></Textarea>
		</div>
	{:else}
		<div class="space-y-1.5">
			<Label for="workflow-id">Workflow ID</Label>
			<Input
				id="workflow-id"
				type="text"
				value={(workflow.id as string) || ''}
				oninput={(e) => updateWorkflow({ id: e.currentTarget.value })}
				placeholder="sub-workflow-id"
			/>
		</div>
		<div class="space-y-1.5">
			<Label for="workflow-version">Version (optional)</Label>
			<Input
				id="workflow-version"
				type="text"
				value={(workflow.version as string) || ''}
				oninput={(e) => updateWorkflow({ version: e.currentTarget.value })}
				placeholder="1.0.0"
			/>
		</div>
	{/if}
</div>
