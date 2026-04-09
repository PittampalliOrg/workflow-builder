<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Switch } from '$lib/components/ui/switch';
	import { Loader2, Plus, X } from 'lucide-svelte';

	interface SandboxDefaults {
		name?: string;
		providers?: string[];
		image?: string;
		gpu?: boolean;
	}

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		onCreated?: () => void;
		defaults?: SandboxDefaults;
	}

	let { open = $bindable(), onOpenChange, onCreated, defaults }: Props = $props();

	let name = $state('');
	let selectedProviders = $state<string[]>(['claude']);
	let image = $state('default');
	let customImage = $state('');
	let gpuEnabled = $state(false);
	let envVars = $state<Array<{ key: string; value: string }>>([]);
	let initialCommand = $state('');
	let creating = $state(false);
	let error = $state<string | null>(null);

	// Apply defaults when dialog opens (e.g., from clone)
	$effect(() => {
		if (open && defaults) {
			if (defaults.name) name = defaults.name;
			if (defaults.providers) selectedProviders = [...defaults.providers];
			if (defaults.image) {
				if (['default', 'claude', 'codex'].includes(defaults.image)) {
					image = defaults.image;
				} else {
					image = 'custom';
					customImage = defaults.image;
				}
			}
			if (defaults.gpu) gpuEnabled = defaults.gpu;
		}
	});

	const PROVIDERS = [
		{ id: 'claude', label: 'Claude', color: 'bg-orange-500/15 text-orange-600' },
		{ id: 'nvidia', label: 'NVIDIA', color: 'bg-green-500/15 text-green-600' },
		{ id: 'openai', label: 'OpenAI', color: 'bg-blue-500/15 text-blue-600' },
		{ id: 'github', label: 'GitHub', color: 'bg-purple-500/15 text-purple-600' },
		{ id: 'gitlab', label: 'GitLab', color: 'bg-orange-500/15 text-orange-600' },
		{ id: 'ollama', label: 'Ollama (local)', color: 'bg-gray-500/15 text-gray-600' }
	];

	const IMAGES = [
		{ id: 'default', label: 'Default sandbox' },
		{ id: 'claude', label: 'Claude Code' },
		{ id: 'codex', label: 'Codex' },
		{ id: 'custom', label: 'Custom image...' }
	];

	function toggleProvider(id: string) {
		if (selectedProviders.includes(id)) {
			selectedProviders = selectedProviders.filter((p) => p !== id);
		} else {
			selectedProviders = [...selectedProviders, id];
		}
	}

	function addEnvVar() {
		envVars = [...envVars, { key: '', value: '' }];
	}

	function removeEnvVar(index: number) {
		envVars = envVars.filter((_, i) => i !== index);
	}

	async function create() {
		if (!name.trim() || creating) return;
		creating = true;
		error = null;

		const provider = selectedProviders[0] ?? 'claude';
		const body: Record<string, unknown> = {
			name: name.trim(),
			provider
		};

		if (image === 'custom' && customImage.trim()) {
			body.image = customImage.trim();
		} else if (image !== 'default') {
			body.image = image;
		}

		if (gpuEnabled) body.gpu = true;

		if (envVars.length > 0) {
			const env: Record<string, string> = {};
			for (const { key, value } of envVars) {
				if (key.trim()) env[key.trim()] = value;
			}
			if (Object.keys(env).length > 0) body.environment = env;
		}

		if (initialCommand.trim()) body.command = initialCommand.trim();

		try {
			const res = await fetch('/api/sandboxes', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			const data = await res.json();
			if (!res.ok || !data.ok) {
				error = data.error ?? 'Failed to create sandbox';
				return;
			}
			// Reset form
			name = '';
			selectedProviders = ['claude'];
			image = 'default';
			customImage = '';
			gpuEnabled = false;
			envVars = [];
			initialCommand = '';
			onOpenChange(false);
			onCreated?.();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create sandbox';
		} finally {
			creating = false;
		}
	}
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Content class="sm:max-w-lg max-h-[85vh] overflow-auto">
		<Dialog.Header>
			<Dialog.Title>Create Sandbox</Dialog.Title>
			<Dialog.Description>Configure and launch a new OpenShell sandbox environment.</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-5 py-4">
			<!-- Name -->
			<div class="flex flex-col gap-1.5">
				<label for="sandbox-name" class="text-sm font-medium">Name</label>
				<input
					id="sandbox-name"
					type="text"
					bind:value={name}
					placeholder="my-sandbox"
					class="rounded border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
				/>
			</div>

			<!-- Providers -->
			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium">Providers</label>
				<p class="text-xs text-muted-foreground">Select credential providers to inject into the sandbox.</p>
				<div class="flex flex-wrap gap-2 mt-1">
					{#each PROVIDERS as provider}
						<button
							onclick={() => toggleProvider(provider.id)}
							class="rounded-full border px-3 py-1 text-xs transition-colors {selectedProviders.includes(provider.id) ? `${provider.color} border-current font-medium` : 'border-border text-muted-foreground hover:border-foreground/30'}"
						>
							{provider.label}
						</button>
					{/each}
				</div>
			</div>

			<!-- Image -->
			<div class="flex flex-col gap-1.5">
				<label for="sandbox-image" class="text-sm font-medium">Base Image</label>
				<NativeSelect bind:value={image}>
					{#each IMAGES as img}
						<option value={img.id}>{img.label}</option>
					{/each}
				</NativeSelect>
				{#if image === 'custom'}
					<input
						type="text"
						bind:value={customImage}
						placeholder="registry.example.com/my-sandbox:latest"
						class="mt-1 rounded border border-border bg-background px-3 py-1.5 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
					/>
				{/if}
			</div>

			<!-- GPU -->
			<div class="flex items-center justify-between">
				<div>
					<label class="text-sm font-medium">GPU Passthrough</label>
					<p class="text-xs text-muted-foreground">Enable NVIDIA GPU access (experimental)</p>
				</div>
				<Switch bind:checked={gpuEnabled} />
			</div>

			<!-- Environment Variables -->
			<div class="flex flex-col gap-1.5">
				<div class="flex items-center justify-between">
					<label class="text-sm font-medium">Environment Variables</label>
					<Button variant="ghost" size="sm" class="h-6 text-xs" onclick={addEnvVar}>
						<Plus class="mr-1 h-3 w-3" />
						Add
					</Button>
				</div>
				{#each envVars as envVar, i}
					<div class="flex items-center gap-2">
						<input
							type="text"
							bind:value={envVar.key}
							placeholder="KEY"
							class="w-1/3 rounded border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
						/>
						<span class="text-muted-foreground">=</span>
						<input
							type="text"
							bind:value={envVar.value}
							placeholder="value"
							class="flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
						/>
						<button onclick={() => removeEnvVar(i)} class="text-muted-foreground hover:text-destructive">
							<X class="h-3.5 w-3.5" />
						</button>
					</div>
				{/each}
			</div>

			<!-- Initial Command -->
			<div class="flex flex-col gap-1.5">
				<label for="initial-command" class="text-sm font-medium">Initial Command</label>
				<input
					id="initial-command"
					type="text"
					bind:value={initialCommand}
					placeholder="Optional: command to run on creation"
					class="rounded border border-border bg-background px-3 py-1.5 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
				/>
			</div>

			{#if error}
				<p class="text-sm text-destructive">{error}</p>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => onOpenChange(false)}>Cancel</Button>
			<Button onclick={create} disabled={!name.trim() || creating}>
				{#if creating}
					<Loader2 class="mr-2 h-4 w-4 animate-spin" />
				{/if}
				Create Sandbox
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
