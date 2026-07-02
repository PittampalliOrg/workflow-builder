import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, locals }) => {
	// Run parallel fetches for all required monitoring endpoints
	const [dashboardRes, runsRes, devEnvsRes, capacityRes, gitopsRes] = await Promise.all([
		fetch('/api/v1/dashboard').catch(() => null),
		fetch('/api/v1/runs?limit=10').catch(() => null),
		fetch('/api/dev-environments').catch(() => null),
		fetch('/api/capacity/overview').catch(() => null),
		fetch('/api/v1/gitops/events?limit=10').catch(() => null)
	]);

	let dashboard = null;
	if (dashboardRes && dashboardRes.ok) {
		dashboard = await dashboardRes.json();
	}

	let recentRuns = [];
	if (runsRes && runsRes.ok) {
		const runsData = await runsRes.json();
		recentRuns = runsData.runs ?? [];
	}

	let devEnvironments = [];
	if (devEnvsRes && devEnvsRes.ok) {
		const devEnvsData = await devEnvsRes.json();
		devEnvironments = devEnvsData.environments ?? [];
	}

	let capacity = null;
	if (capacityRes && capacityRes.ok) {
		capacity = await capacityRes.json();
	}

	let gitops = null;
	if (gitopsRes && gitopsRes.ok) {
		gitops = await gitopsRes.json();
	}

	return {
		dashboard,
		recentRuns,
		devEnvironments,
		capacity,
		gitops,
		user: locals.session ? { name: null, email: locals.session.email } : null
	};
};
