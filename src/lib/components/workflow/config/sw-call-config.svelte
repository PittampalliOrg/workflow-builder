<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Textarea } from '$lib/components/ui/textarea';
	import ApFunctionConfig from './ap-function-config.svelte';
	import CodeFunctionInputEditor from './code-function-input-editor.svelte';

	interface Props {
		data: Record<string, unknown>;
		onUpdate: (key: string, value: unknown) => void;
	}

	let { data, onUpdate }: Props = $props();

	let isApFunction = $derived(
		Boolean(data.catalogFunction) ||
		Boolean((((data.taskConfig as Record<string, unknown>)?.with as Record<string, unknown>)?.body as Record<string, unknown>)?.metadata)
	);
	let isCodeFunction = $derived(Boolean(data.codeFunction));
	let catalogFunction = $derived(
		(data.catalogFunction as { name: string; displayName: string; pieceName: string; actionName: string } | undefined) || null
	);
	let codeFunction = $derived(
		(data.codeFunction as {
			id: string;
			name: string;
			slug: string;
			language: string;
			entrypoint: string;
			version: string;
			path?: string | null;
		} | undefined) || null
	);
	let codeFunctionDefinition = $derived(
		(data.codeFunctionDefinition as Record<string, unknown> | undefined) || null
	);
	let codeSemanticModel = $derived(
		(codeFunctionDefinition?.semanticModel as
			| {
					params?: Array<{
						name?: string;
						type?: {
							kind?: string;
							resource_type?: string | null;
							properties?: Array<{
								name?: string;
								type?: { resource_type?: string | null };
							}>;
						};
						schema?: Record<string, unknown>;
						dynamic_input?: {
							handler?: string;
							depends_on?: string[];
							search?: boolean;
						} | null;
					}>;
					dynamic_inputs?: Array<{
						name?: string;
						handler?: string;
						depends_on?: string[];
						search?: boolean;
					}>;
			  }
			| undefined) || undefined
	);
	let singleObjectParam = $derived.by(() => {
		const params = codeSemanticModel?.params || [];
		if (params.length !== 1) return null;
		const [param] = params;
		return param?.type?.kind === 'object' ? param : null;
	});
	let codeInputSchema = $derived.by(() => {
		if (singleObjectParam?.schema && typeof singleObjectParam.schema === 'object') {
			return singleObjectParam.schema as Record<string, unknown>;
		}
		return (
			(codeFunctionDefinition?.input as { schema?: { document?: Record<string, unknown> } } | undefined)
				?.schema?.document ||
			(codeFunctionDefinition?.inputSchema as { document?: Record<string, unknown> } | undefined)
				?.document ||
			null
		) as Record<string, unknown> | null;
	});
	let codeInputResourceTypes = $derived.by(() => {
		const entries = (
			singleObjectParam?.type?.properties?.length
				? singleObjectParam.type.properties.map((property) => {
						const name = typeof property.name === 'string' ? property.name : '';
						const resourceType =
							typeof property.type?.resource_type === 'string' && property.type.resource_type.trim()
								? property.type.resource_type.trim()
								: null;
						return name && resourceType ? [name, resourceType] : null;
					})
				: (codeSemanticModel?.params || []).map((param) => {
						const name = typeof param.name === 'string' ? param.name : '';
						const resourceType =
							typeof param.type?.resource_type === 'string' && param.type.resource_type.trim()
								? param.type.resource_type.trim()
								: null;
						return name && resourceType ? [name, resourceType] : null;
					})
		)
			.filter((entry): entry is [string, string] => Array.isArray(entry));
		return Object.fromEntries(entries);
	});
	let codeDynamicInputs = $derived.by(() => {
		const entries = [
			...(codeSemanticModel?.dynamic_inputs || []).map((item) => {
				const name = typeof item.name === 'string' ? item.name : '';
				const handler = typeof item.handler === 'string' ? item.handler : '';
				return name && handler
					? [name, { handler, depends_on: item.depends_on || [], search: item.search === true }]
					: null;
			}),
			...(codeSemanticModel?.params || []).map((param) => {
				const name = typeof param.name === 'string' ? param.name : '';
				const handler = typeof param.dynamic_input?.handler === 'string' ? param.dynamic_input.handler : '';
				return name && handler
					? [
							name,
							{
								handler,
								depends_on: param.dynamic_input?.depends_on || [],
								search: param.dynamic_input?.search === true,
							},
						]
					: null;
			}),
		].filter(
			(
				entry,
			): entry is [string, { handler: string; depends_on: string[]; search: boolean }] =>
				Array.isArray(entry),
		);
		return Object.fromEntries(entries);
	});
	let showRawConfig = $state(false);

	let taskConfig = $derived((data.taskConfig as Record<string, unknown>) || {});
	let withConfig = $derived((taskConfig.with as Record<string, unknown>) || {});
	let codeBody = $derived((withConfig.body as Record<string, unknown>) || {});
	let codeInputValues = $derived((codeBody.input as Record<string, unknown>) || {});
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

	function updateCodeInput(values: Record<string, unknown>) {
		updateWith({
			body: {
				...codeBody,
				input: values,
			},
		});
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
	{#if isCodeFunction && codeFunction}
		<div class="rounded-lg border border-border/70 p-3">
			<div class="flex items-center justify-between gap-3">
				<div>
					<p class="text-xs font-semibold">{codeFunction.name}</p>
					<p class="text-[10px] text-muted-foreground">{codeFunction.entrypoint}</p>
				</div>
				<div class="flex items-center gap-1.5">
					<Badge variant="secondary" class="text-[9px]">{codeFunction.language}</Badge>
					<Badge variant="outline" class="text-[9px]">{codeFunction.version}</Badge>
				</div>
			</div>
			{#if codeFunction.path}
				<p class="mt-2 text-[10px] text-muted-foreground">{codeFunction.path}</p>
			{/if}
			<p class="mt-2 text-[10px] text-muted-foreground">
				Execution is routed through <code>function-router</code> for single-file TS/Python functions.
			</p>
		</div>
		{#if codeInputSchema}
			<CodeFunctionInputEditor
				schema={codeInputSchema}
				values={codeInputValues}
				resourceTypes={codeInputResourceTypes}
				dynamicInputs={codeDynamicInputs}
				codeFunctionRef={{
					id: codeFunction.id,
					slug: codeFunction.slug,
					version: codeFunction.version,
				}}
				onChange={updateCodeInput}
			/>
		{:else}
			<div class="rounded-lg border border-dashed border-border/70 bg-muted/20 p-3 text-xs text-muted-foreground">
				This code function does not expose parser input schema yet.
			</div>
		{/if}
		<button
			class="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
			onclick={() => (showRawConfig = !showRawConfig)}
		>
			{showRawConfig ? 'Hide' : 'Show'} raw config
		</button>
	{/if}

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

	{#if (!isApFunction && !isCodeFunction) || showRawConfig}
	<div class="space-y-4">
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
	</div>
	{/if}

	{#if isCodeFunction && showRawConfig}
		<div class="space-y-2 rounded-lg border border-border/70 bg-muted/20 p-3">
			<div class="flex items-center justify-between gap-3">
				<Label class="text-xs font-medium">Raw taskConfig</Label>
				<Badge variant="outline" class="text-[9px]">read-only</Badge>
			</div>
			<Textarea
				rows={12}
				class="font-mono text-[11px]"
				value={JSON.stringify(taskConfig, null, 2)}
				readonly
			/>
		</div>
	{/if}
</div>
