<script lang="ts">
	import * as Breadcrumb from '$lib/components/ui/breadcrumb';

	export type AppBreadcrumbItem = {
		label: string;
		href?: string;
		mono?: boolean;
		truncate?: boolean;
	};

	interface Props {
		items: AppBreadcrumbItem[];
		class?: string;
	}

	let { items, class: className = '' }: Props = $props();
</script>

<Breadcrumb.Root class={className}>
	<Breadcrumb.List class="gap-1 text-xs">
		{#each items as item, i (i)}
			<Breadcrumb.Item>
				{#if i === items.length - 1 || !item.href}
					<Breadcrumb.Page
						class={`text-xs ${item.mono ? 'font-mono' : ''} ${item.truncate ? 'truncate max-w-[240px]' : ''}`}
						title={item.truncate ? item.label : undefined}
					>
						{item.label}
					</Breadcrumb.Page>
				{:else}
					<Breadcrumb.Link
						href={item.href}
						class={`text-xs ${item.mono ? 'font-mono' : ''} ${item.truncate ? 'truncate max-w-[240px]' : ''}`}
						title={item.truncate ? item.label : undefined}
					>
						{item.label}
					</Breadcrumb.Link>
				{/if}
			</Breadcrumb.Item>
			{#if i < items.length - 1}
				<Breadcrumb.Separator class="[&>svg]:size-3" />
			{/if}
		{/each}
	</Breadcrumb.List>
</Breadcrumb.Root>
