<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Textarea } from '$lib/components/ui/textarea';
	import ApFunctionConfig from './ap-function-config.svelte';

	interface Props {
		data: Record<string, unknown>;
		onUpdate: (key: string, value: unknown) => void;
	}

	let { data, onUpdate }: Props = $props();

	let isApFunction = $derived(
		Boolean(data.catalogFunction) ||
		Boolean((((data.taskConfig as Record<string, unknown>)?.with as Record<string, unknown>)?.body as Record<string, unknown>)?.metadata)
	);
	let catalogFunction = $derived(
		(data.catalogFunction as { name: string; displayName: string; pieceName: string; actionName: string } | undefined) || null
	);
	let showRawConfig = $state(false);

	let taskConfig = $derived((data.taskConfig as Record<string, unknown>) || {});
	let withConfig = $derived((taskConfig.with as Record<string, unknown>) || {});
	let endpoint = $derived((withConfig.endpoint as Record<string, unknown>) || {});
	let headers = $derived((withConfig.headers as Record<string, string>) || {});

	let callType = $derived((taskConfig.call as string) || 'http');
	let method = $derived((withConfig.method as string) || 'GET');
	let uri = $derived((endpoint.uri as string) || '');
	let body = $derived((withConfig.body as string) || '');

	let headerEntries = $derived(Object.entries(headers));

	function updateTaskConfig(updates: Record<string, unknown>) {
		const current = { ...taskConfig, ...updates };
		onUpdate('taskConfig', current);
	}

	function updateWith(updates: Record<string, unknown>) {
		updateTaskConfig({ with: { ...withConfig, ...updates } });
	}

	function updateEndpoint(updates: Record<string, unknown>) {
		updateWith({ endpoint: { ...endpoint, ...updates } });
	}

	function setCallType(value: string) {
		updateTaskConfig({ call: value });
	}

	function setMethod(value: string) {
		updateWith({ method: value });
	}

	function setUri(value: string) {
		updateEndpoint({ uri: value });
	}

	function setBody(value: string) {
		updateWith({ body: value });
	}

	function setHeader(oldKey: string, newKey: string, value: string) {
		const h = { ...headers };
		if (oldKey !== newKey) delete h[oldKey];
		h[newKey] = value;
		updateWith({ headers: h });
	}

	function removeHeader(key: string) {
		const h = { ...headers };
		delete h[key];
		updateWith({ headers: h });
	}

	function addHeader() {
		const h = { ...headers, '': '' };
		updateWith({ headers: h });
	}
</script>

<div class="space-y-4">
	{#if isApFunction && catalogFunction}
		<ApFunctionConfig
			{catalogFunction}
			taskConfig={taskConfig}
			{onUpdate}
		/>
		<button
			class="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
			onclick={() => (showRawConfig = !showRawConfig)}
		>
			{showRawConfig ? 'Hide' : 'Show'} raw config
		</button>
	{/if}

	{#if !isApFunction || showRawConfig}
	<div class="space-y-1.5">
		<Label for="call-type">Call Type</Label>
		<NativeSelect
			class="w-full"
			id="call-type"
			value={callType}
			onchange={(e) => setCallType(e.currentTarget.value)}
		>
			<option value="http">HTTP</option>
			<option value="grpc">gRPC</option>
			<option value="openapi">OpenAPI</option>
			<option value="asyncapi">AsyncAPI</option>
		</NativeSelect>
	</div>

	{#if callType === 'http'}
		<div class="space-y-1.5">
			<Label for="http-method">Method</Label>
			<NativeSelect
				class="w-full"
				id="http-method"
				value={method}
				onchange={(e) => setMethod(e.currentTarget.value)}
			>
				<option value="GET">GET</option>
				<option value="POST">POST</option>
				<option value="PUT">PUT</option>
				<option value="PATCH">PATCH</option>
				<option value="DELETE">DELETE</option>
				<option value="HEAD">HEAD</option>
				<option value="OPTIONS">OPTIONS</option>
			</NativeSelect>
		</div>

		<div class="space-y-1.5">
			<Label for="endpoint-uri">Endpoint URI</Label>
			<Input
				id="endpoint-uri"
				type="text"
				value={uri}
				oninput={(e) => setUri(e.currentTarget.value)}
				placeholder="https://api.example.com/resource"
			/>
		</div>

		<div>
			<div class="flex items-center justify-between">
				<Label>Headers</Label>
				<Button variant="ghost" size="sm" onclick={addHeader}>+ Add</Button>
			</div>
			<div class="mt-1 space-y-1">
				{#each headerEntries as [key, value], i}
					<div class="flex gap-1">
						<Input
							type="text"
							value={key}
							placeholder="Header name"
							onchange={(e) => setHeader(key, e.currentTarget.value, value)}
						/>
						<Input
							type="text"
							value={value}
							placeholder="Value"
							oninput={(e) => setHeader(key, key, e.currentTarget.value)}
						/>
						<Button
							variant="ghost"
							size="icon-xs"
							class="text-destructive hover:bg-destructive/10"
							onclick={() => removeHeader(key)}
						>
							x
						</Button>
					</div>
				{/each}
			</div>
		</div>

		<div class="space-y-1.5">
			<Label for="request-body">Body</Label>
			<Textarea
				id="request-body"
				value={body}
				oninput={(e) => setBody(e.currentTarget.value)}
				placeholder={'{"key": "value"}'}
				rows={5}
			></Textarea>
		</div>
	{:else}
		<div class="space-y-1.5">
			<Label for="call-target">Call Target</Label>
			<Input
				id="call-target"
				type="text"
				value={callType === 'grpc' ? (withConfig.service as string || '') : (withConfig.document as string || '')}
				oninput={(e) => updateWith(callType === 'grpc' ? { service: e.currentTarget.value } : { document: e.currentTarget.value })}
				placeholder={callType === 'grpc' ? 'service.Method' : 'path/to/spec.yaml'}
			/>
		</div>
	{/if}
	{/if}
</div>
