export const meta = {
	name: 'team-research',
	description:
		'Script-led Agent Team: spawn two persistent teammates, seed a dependency-gated shared task list, broadcast kickoff, await quiescence, return the final team snapshot.',
	phases: [
		{ title: 'Form' },
		{ title: 'Work' },
	],
	// Team-wide token cap (input+output across every member session). Once
	// exhausted, spawn refuses and idle teammates stop being fed new tasks —
	// a healthy full run of this demo uses ~50k, so 150k is a generous ceiling
	// that still demonstrates the budget chip draining in TeamPulse.
	team: { tokenBudget: 150000 },
}

// THE SCRIPT IS THE LEAD: it deterministically forms the team and seeds work;
// the teammates coordinate autonomously underneath (claim unblocked tasks,
// message each other, suspend when idle, wake on any message).
phase('Form')
const researcher = await team.spawn({
	name: 'researcher',
	agent: args?.agent ?? 'team-tester-glm',
	prompt:
		'You are the `researcher` on a 2-person team. Call claim_task to take your next unblocked task from the shared list; do the work, then: (1) publish_knowledge({path: "findings/use-cases.md", type: "Finding", title: "Suspend/resume use-cases", description: "Five one-line use-cases.", body: <the full list>}) so the team knowledge bundle carries your work, (2) call update_task(taskId, "completed", note) where note IS THE FULL DELIVERABLE TEXT, and (3) send_message the full list to "writer" (they need it for the summary). Repeat claim_task until it returns null, then stop. Task 1 will ask you to list 5 practical use-cases for suspend/resume of idle AI agents (one line each).',
})
const writer = await team.spawn({
	name: 'writer',
	agent: args?.agent ?? 'team-tester-glm',
	prompt:
		'You are the `writer` on a 2-person team. Call claim_task to take your next unblocked task; your task depends on the researcher finishing, so if claim_task returns null just reply "waiting" and stop — you will be nudged when work unblocks. When you get the task: read the researcher\'s finding (read_knowledge({path: "findings/use-cases.md"}) — or use their message), write a crisp 5-sentence summary paragraph, then: (1) publish_knowledge({path: "deliverable/summary.md", type: "Deliverable", title: "Executive summary", description: "One-paragraph synthesis of the use-cases.", body: <the paragraph, ending with a citation line linking [the finding](/findings/use-cases.md)>}), and (2) call update_task(taskId, "completed", note) with THE PARAGRAPH AS THE NOTE.',
})

// Seed the shared ledger: t2 is GATED on t1 (the writer stays idle/suspended
// until the researcher completes — the claim query enforces the dependency).
const t1 = await team.task({
	title: 'List 5 practical use-cases for suspending idle AI agents',
	description:
		'Produce 5 one-line use-cases for scale-to-zero suspension of idle agent sandboxes (cost, capacity, wake-on-message...). Reply with the list, then complete this task.',
})
const t2 = await team.task({
	title: 'Write the summary paragraph',
	description:
		'Turn the researcher\'s 5 use-cases into one crisp 5-sentence paragraph. Reply with the paragraph, then complete this task.',
	dependsOn: [t1.task.id],
})

await team.broadcast('Kickoff: the task list is seeded — call claim_task now.')

phase('Work')
const final = await team.join({ until: 'tasks-complete', timeoutMinutes: 15 })
// join RESOLVES on timeout — surface it honestly instead of pretending success.
log(
	`team.join: satisfied=${final.satisfied} timedOut=${final.timedOut} after ${final.polls} polls`,
)

// THE RESULTS CHANNEL: completed tasks carry the deliverable in `note`
// (update_task's third argument). The script — the lead — synthesizes the
// run's OUTPUT from those notes, so the Outputs tab holds the actual work
// product, not just coordination state.
const notes = Object.fromEntries(
	(final.tasks ?? []).map((t) => [t.title, t.note ?? null]),
)
const summary = notes['Write the summary paragraph']
const useCases = notes['List 5 practical use-cases for suspending idle AI agents']

return {
	deliverable: summary ?? '(writer did not attach a completion note)',
	supporting: { useCases: useCases ?? '(researcher did not attach a completion note)' },
	// The durable CONTENT layer: teammates also published their work as OKF
	// concepts (findings/use-cases.md, deliverable/summary.md) — exportable as a
	// spec-conformant bundle and listed in TeamPulse's Knowledge section.
	knowledgeBundle: final.team
		? `/api/v1/teams/${final.team.id}/knowledge/bundle`
		: null,
	spawned: [researcher.name, writer.name],
	satisfied: final.satisfied,
	timedOut: final.timedOut,
	tasks: (final.tasks ?? []).map((t) => ({
		title: t.title,
		status: t.status,
		hasNote: !!t.note,
	})),
	members: (final.members ?? []).map((m) => ({ name: m.name, status: m.status })),
}
