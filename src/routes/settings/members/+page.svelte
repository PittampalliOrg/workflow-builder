<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Users, ExternalLink, Plus } from 'lucide-svelte';
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="text-lg font-semibold flex items-center gap-2">
				<Users class="size-4" /> Members
			</h2>
			<p class="text-xs text-muted-foreground mt-1">
				People with access to this workspace.
			</p>
		</div>
		<Button>
			<Plus class="size-4" /> Invite member
		</Button>
	</div>

	<Alert>
		<AlertDescription class="text-xs">
			Member management is backed by the existing <code>users</code> + <code>projects</code>
			tables. Invite flow uses the OAuth providers configured in
			<a href="/settings" class="text-primary hover:underline">
				legacy settings <ExternalLink class="inline size-3" />
			</a>.
		</AlertDescription>
	</Alert>

	<Card>
		<CardHeader>
			<CardTitle class="text-base">Roles</CardTitle>
			<CardDescription>
				Platform-scoped roles apply across every project.
			</CardDescription>
		</CardHeader>
		<CardContent>
			<table class="w-full text-xs">
				<thead class="text-left text-[10px] uppercase tracking-wide text-muted-foreground border-b">
					<tr>
						<th class="pb-2 font-medium">Role</th>
						<th class="pb-2 font-medium">Access</th>
					</tr>
				</thead>
				<tbody class="divide-y">
					<tr>
						<td class="py-2 font-medium">ADMIN</td>
						<td class="py-2">All projects + <code>/api/admin</code> endpoints.</td>
					</tr>
					<tr>
						<td class="py-2 font-medium">MEMBER</td>
						<td class="py-2">Projects they're a member of; can create agents/sessions.</td>
					</tr>
				</tbody>
			</table>
		</CardContent>
	</Card>
</div>
