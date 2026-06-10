<script lang="ts">
	import { Globe, PackageCheck } from '@lucide/svelte';
	import BaseSWNode from '../base-sw-node.svelte';
	import type { PortConfig } from '$lib/types/workflow-handles';
	import {
		extractTaskConnectionRef,
		useConnectionRegistry,
	} from '../../connection-registry.svelte';

	interface Props {
		data: Record<string, unknown>;
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const ports: PortConfig[] = [
		{ id: 'target', type: 'target', position: 'top', rule: { dataType: 'control' } },
		{ id: 'source', type: 'source', position: 'bottom', rule: { dataType: 'control' } }
	];

	let subtitle = $derived.by(() => {
		const config = data.taskConfig as Record<string, unknown> | undefined;
		const build = data.environmentBuild as Record<string, unknown> | undefined;
		if (config?.call === 'environment/ensure' && build) {
			const status = typeof build.environmentStatus === 'string'
				? build.environmentStatus
				: typeof build.status === 'string'
					? build.status
					: 'building';
			const latest = build.latestActivityEvent as Record<string, unknown> | undefined;
			const latestType = typeof latest?.eventType === 'string' ? latest.eventType.replaceAll('_', ' ') : '';
			return latestType ? `${status} · ${latestType}` : status;
		}
		if (config?.call) return String(config.call);
		return '';
	});

	let isEnvironmentNode = $derived.by(() => {
		const config = data.taskConfig as Record<string, unknown> | undefined;
		return config?.call === 'environment/ensure';
	});

	let environmentStatus = $derived.by(() => {
		const build = data.environmentBuild as Record<string, unknown> | undefined;
		const status = typeof build?.environmentStatus === 'string'
			? build.environmentStatus
			: typeof build?.status === 'string'
				? build.status
				: null;
		if (status === 'validated' || status === 'succeeded') return 'success';
		if (status === 'failed' || status === 'cancelled') return 'error';
		if (status === 'building' || status === 'queued' || status === 'validating' || status === 'pushing') return 'running';
		return data.status as string | undefined;
	});

	// Extract provider icon URL from action catalog detail or catalog function
	let providerIconUrl = $derived.by(() => {
		const detail = data.actionCatalogDetail as Record<string, unknown> | undefined;
		if (typeof detail?.providerIconUrl === 'string' && detail.providerIconUrl.length > 0) {
			return detail.providerIconUrl;
		}
		return null;
	});

	// Warning dot when this node's {{connections['…']}} ref doesn't resolve to
	// an existing app connection (advisory; shared lazy registry).
	const connectionRegistry = useConnectionRegistry();
	let connectionWarning = $derived.by(() => {
		const ref = extractTaskConnectionRef(
			data.taskConfig as Record<string, unknown> | undefined,
		);
		if (!ref || !connectionRegistry.loaded) return null;
		return connectionRegistry.ids.has(ref)
			? null
			: `Connection '${ref}' was not found — pick a valid connection in the step panel`;
	});

	let nodeData = $derived({
		...data,
		...(subtitle ? { description: subtitle } : {}),
		...(isEnvironmentNode && environmentStatus ? { status: environmentStatus } : {}),
	});
	let Icon = $derived(isEnvironmentNode ? PackageCheck : Globe);
	let iconColor = $derived(
		isEnvironmentNode
			? environmentStatus === 'success'
				? 'bg-emerald-500/15 text-emerald-500'
				: environmentStatus === 'error'
					? 'bg-red-500/15 text-red-500'
					: 'bg-blue-500/15 text-blue-500'
			: 'bg-amber-500/15 text-amber-400'
	);
</script>

<BaseSWNode data={nodeData} {selected} {ports} icon={Icon} {iconColor} {providerIconUrl} warning={connectionWarning} />
