export const meta = {
	name: 'team-research',
	description:
		'Script-led Agent Team: spawn two persistent teammates, seed a dependency-gated shared task list, broadcast kickoff, await quiescence, return the final team snapshot.',
	phases: [
		{ title: 'Form' },
		{ title: 'Work' },
	],
}

// THE SCRIPT IS THE LEAD: it deterministically forms the team and seeds work;
// the teammates coordinate autonomously underneath (claim unblocked tasks,
// message each other, suspend when idle, wake on any message).
phase('Form')
const researcher = await team.spawn({
	name: 'researcher',
	agent: args?.agent ?? 'team-tester-glm',
	prompt:
		'You are the `researcher` on a 2-person team. Call claim_task to take your next unblocked task from the shared list; do the work IN YOUR REPLY (no file tools needed); call update_task(taskId, "completed") when done; repeat until claim_task returns null, then stop. Task 1 will ask you to list 5 practical use-cases for suspend/resume of idle AI agents (one line each).',
})
const writer = await team.spawn({
	name: 'writer',
	agent: args?.agent ?? 'team-tester-glm',
	prompt:
		'You are the `writer` on a 2-person team. Call claim_task to take your next unblocked task; your task depends on the researcher finishing, so if claim_task returns null just reply "waiting" and stop — you will be nudged when work unblocks. When you get the task: write a crisp 5-sentence summary paragraph of the use-cases (from the task description), reply with it, and call update_task(taskId, "completed").',
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
return {
	spawned: [researcher.name, writer.name],
	satisfied: final.satisfied,
	timedOut: final.timedOut,
	tasks: (final.tasks ?? []).map((t) => ({ title: t.title, status: t.status })),
	members: (final.members ?? []).map((m) => ({ name: m.name, status: m.status })),
}
