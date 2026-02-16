/**
 * Database Layer
 *
 * Raw pg.Pool access to workflows, functions, and piece_metadata tables.
 */

import pg from "pg";
import { nanoid } from "nanoid";
import { customAlphabet } from "nanoid";

const generateId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 21);

// ── Types ──────────────────────────────────────────────────

export type NodeData = {
	id: string;
	type: string;
	position: { x: number; y: number };
	data: {
		label: string;
		description?: string;
		type: string;
		config?: Record<string, unknown>;
		status?: string;
		enabled?: boolean;
	};
};

export type EdgeData = {
	id: string;
	source: string;
	target: string;
	sourceHandle?: string;
	targetHandle?: string;
};

export type WorkflowSummary = {
	id: string;
	name: string;
	description: string | null;
	visibility: string;
	created_at: string;
	updated_at: string;
	node_count: number;
	edge_count: number;
};

export type WorkflowRow = {
	id: string;
	name: string;
	description: string | null;
	nodes: NodeData[];
	edges: EdgeData[];
	visibility: string;
	created_at: string;
	updated_at: string;
};

export type ActionSummary = {
	slug: string;
	name: string;
	description: string | null;
	category: string | null;
	source: "builtin" | "piece";
};

// ── Pool ───────────────────────────────────────────────────

let pool: pg.Pool;

export function initDb(): void {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is required");
	}
	if (!process.env.USER_ID) {
		console.warn(
			"[wf-mcp] USER_ID not set — write operations (create/duplicate) will fail",
		);
	}
	pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

export function getPool(): pg.Pool {
	return pool;
}

// ── Helpers ────────────────────────────────────────────────

function createDefaultTriggerNode(): NodeData {
	return {
		id: nanoid(),
		type: "trigger",
		position: { x: 0, y: 0 },
		data: {
			label: "Manual Trigger",
			description: "Workflow entry point",
			type: "trigger",
			config: { triggerType: "Manual" },
			status: "idle",
		},
	};
}

// ── Query Functions ────────────────────────────────────────

export async function listWorkflows(
	userId?: string,
): Promise<WorkflowSummary[]> {
	const userIdFilter = userId ?? process.env.USER_ID;
	let query = `
		SELECT id, name, description, visibility, created_at, updated_at,
			jsonb_array_length(nodes) as node_count,
			jsonb_array_length(edges) as edge_count
		FROM workflows
	`;
	const params: string[] = [];
	if (userIdFilter) {
		query += ` WHERE user_id = $1`;
		params.push(userIdFilter);
	}
	query += ` ORDER BY updated_at DESC`;

	const result = await pool.query(query, params);
	return result.rows.map((r) => ({
		...r,
		created_at: r.created_at?.toISOString?.() ?? r.created_at,
		updated_at: r.updated_at?.toISOString?.() ?? r.updated_at,
	}));
}

export async function getWorkflow(id: string): Promise<WorkflowRow | null> {
	const result = await pool.query(
		`SELECT id, name, description, nodes, edges, visibility, created_at, updated_at
		 FROM workflows WHERE id = $1`,
		[id],
	);
	if (result.rows.length === 0) return null;
	const r = result.rows[0];
	return {
		...r,
		created_at: r.created_at?.toISOString?.() ?? r.created_at,
		updated_at: r.updated_at?.toISOString?.() ?? r.updated_at,
	};
}

export async function createWorkflow(
	name: string,
	description?: string,
	userId?: string,
): Promise<WorkflowRow> {
	const id = generateId();
	const triggerNode = createDefaultTriggerNode();
	const userIdFilter = userId ?? process.env.USER_ID;

	const result = await pool.query(
		`INSERT INTO workflows (id, name, description, nodes, edges, user_id)
		 VALUES ($1, $2, $3, $4::jsonb, '[]'::jsonb, $5)
		 RETURNING id, name, description, nodes, edges, visibility, created_at, updated_at`,
		[
			id,
			name,
			description ?? null,
			JSON.stringify([triggerNode]),
			userIdFilter ?? null,
		],
	);
	const r = result.rows[0];
	return {
		...r,
		created_at: r.created_at?.toISOString?.() ?? r.created_at,
		updated_at: r.updated_at?.toISOString?.() ?? r.updated_at,
	};
}

export async function updateWorkflow(
	id: string,
	fields: {
		name?: string;
		description?: string;
		visibility?: string;
		nodes?: NodeData[];
		edges?: EdgeData[];
	},
): Promise<WorkflowRow | null> {
	const setClauses: string[] = [];
	const params: unknown[] = [];
	let idx = 1;

	if (fields.name !== undefined) {
		setClauses.push(`name = $${idx++}`);
		params.push(fields.name);
	}
	if (fields.description !== undefined) {
		setClauses.push(`description = $${idx++}`);
		params.push(fields.description);
	}
	if (fields.visibility !== undefined) {
		setClauses.push(`visibility = $${idx++}`);
		params.push(fields.visibility);
	}
	if (fields.nodes !== undefined) {
		setClauses.push(`nodes = $${idx++}::jsonb`);
		params.push(JSON.stringify(fields.nodes));
	}
	if (fields.edges !== undefined) {
		setClauses.push(`edges = $${idx++}::jsonb`);
		params.push(JSON.stringify(fields.edges));
	}

	if (setClauses.length === 0) return getWorkflow(id);

	setClauses.push(`updated_at = NOW()`);
	params.push(id);

	const result = await pool.query(
		`UPDATE workflows SET ${setClauses.join(", ")} WHERE id = $${idx}
		 RETURNING id, name, description, nodes, edges, visibility, created_at, updated_at`,
		params,
	);
	if (result.rows.length === 0) return null;
	const r = result.rows[0];
	return {
		...r,
		created_at: r.created_at?.toISOString?.() ?? r.created_at,
		updated_at: r.updated_at?.toISOString?.() ?? r.updated_at,
	};
}

export async function deleteWorkflow(id: string): Promise<boolean> {
	const result = await pool.query(`DELETE FROM workflows WHERE id = $1`, [id]);
	return (result.rowCount ?? 0) > 0;
}

export async function duplicateWorkflow(
	id: string,
	userId?: string,
): Promise<WorkflowRow | null> {
	const source = await getWorkflow(id);
	if (!source) return null;

	const oldNodes = source.nodes;
	const idMap = new Map<string, string>();

	// Remap node IDs
	const newNodes = oldNodes.map((node) => {
		const newId = nanoid();
		idMap.set(node.id, newId);
		return {
			...node,
			id: newId,
			data: {
				...node.data,
				config: node.data.config
					? (() => {
							const {
								integrationId: _,
								auth: _a,
								...rest
							} = node.data.config as Record<string, unknown>;
							return rest;
						})()
					: undefined,
				status: "idle",
			},
		};
	});

	// Remap edge IDs and references
	const newEdges = source.edges.map((edge) => ({
		...edge,
		id: nanoid(),
		source: idMap.get(edge.source) ?? edge.source,
		target: idMap.get(edge.target) ?? edge.target,
	}));

	const newId = generateId();
	const userIdFilter = userId ?? process.env.USER_ID;

	const result = await pool.query(
		`INSERT INTO workflows (id, name, description, nodes, edges, visibility, user_id)
		 VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'private', $6)
		 RETURNING id, name, description, nodes, edges, visibility, created_at, updated_at`,
		[
			newId,
			`${source.name} (Copy)`,
			source.description,
			JSON.stringify(newNodes),
			JSON.stringify(newEdges),
			userIdFilter ?? null,
		],
	);
	const r = result.rows[0];
	return {
		...r,
		created_at: r.created_at?.toISOString?.() ?? r.created_at,
		updated_at: r.updated_at?.toISOString?.() ?? r.updated_at,
	};
}

export async function addNode(
	workflowId: string,
	node: NodeData,
): Promise<WorkflowRow | null> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const res = await client.query(
			`SELECT nodes FROM workflows WHERE id = $1 FOR UPDATE`,
			[workflowId],
		);
		if (res.rows.length === 0) {
			await client.query("ROLLBACK");
			return null;
		}
		const nodes: NodeData[] = res.rows[0].nodes;
		nodes.push(node);

		const updateRes = await client.query(
			`UPDATE workflows SET nodes = $1::jsonb, updated_at = NOW() WHERE id = $2
			 RETURNING id, name, description, nodes, edges, visibility, created_at, updated_at`,
			[JSON.stringify(nodes), workflowId],
		);
		await client.query("COMMIT");
		const r = updateRes.rows[0];
		return {
			...r,
			created_at: r.created_at?.toISOString?.() ?? r.created_at,
			updated_at: r.updated_at?.toISOString?.() ?? r.updated_at,
		};
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

export async function updateNode(
	workflowId: string,
	nodeId: string,
	updates: {
		label?: string;
		description?: string;
		position?: { x: number; y: number };
		config?: Record<string, unknown>;
		enabled?: boolean;
	},
): Promise<WorkflowRow | null> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const res = await client.query(
			`SELECT nodes FROM workflows WHERE id = $1 FOR UPDATE`,
			[workflowId],
		);
		if (res.rows.length === 0) {
			await client.query("ROLLBACK");
			return null;
		}
		const nodes: NodeData[] = res.rows[0].nodes;
		const nodeIdx = nodes.findIndex((n) => n.id === nodeId);
		if (nodeIdx === -1) {
			await client.query("ROLLBACK");
			throw new Error(`Node "${nodeId}" not found in workflow`);
		}

		const node = nodes[nodeIdx];
		if (updates.label !== undefined) node.data.label = updates.label;
		if (updates.description !== undefined)
			node.data.description = updates.description;
		if (updates.position !== undefined) node.position = updates.position;
		if (updates.config !== undefined)
			node.data.config = { ...node.data.config, ...updates.config };
		if (updates.enabled !== undefined) node.data.enabled = updates.enabled;

		const updateRes = await client.query(
			`UPDATE workflows SET nodes = $1::jsonb, updated_at = NOW() WHERE id = $2
			 RETURNING id, name, description, nodes, edges, visibility, created_at, updated_at`,
			[JSON.stringify(nodes), workflowId],
		);
		await client.query("COMMIT");
		const r = updateRes.rows[0];
		return {
			...r,
			created_at: r.created_at?.toISOString?.() ?? r.created_at,
			updated_at: r.updated_at?.toISOString?.() ?? r.updated_at,
		};
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

export async function deleteNode(
	workflowId: string,
	nodeId: string,
): Promise<WorkflowRow | null> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const res = await client.query(
			`SELECT nodes, edges FROM workflows WHERE id = $1 FOR UPDATE`,
			[workflowId],
		);
		if (res.rows.length === 0) {
			await client.query("ROLLBACK");
			return null;
		}
		const nodes: NodeData[] = res.rows[0].nodes.filter(
			(n: NodeData) => n.id !== nodeId,
		);
		const edges: EdgeData[] = res.rows[0].edges.filter(
			(e: EdgeData) => e.source !== nodeId && e.target !== nodeId,
		);

		const updateRes = await client.query(
			`UPDATE workflows SET nodes = $1::jsonb, edges = $2::jsonb, updated_at = NOW() WHERE id = $3
			 RETURNING id, name, description, nodes, edges, visibility, created_at, updated_at`,
			[JSON.stringify(nodes), JSON.stringify(edges), workflowId],
		);
		await client.query("COMMIT");
		const r = updateRes.rows[0];
		return {
			...r,
			created_at: r.created_at?.toISOString?.() ?? r.created_at,
			updated_at: r.updated_at?.toISOString?.() ?? r.updated_at,
		};
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

export async function connectNodes(
	workflowId: string,
	edge: EdgeData,
): Promise<WorkflowRow | null> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const res = await client.query(
			`SELECT edges FROM workflows WHERE id = $1 FOR UPDATE`,
			[workflowId],
		);
		if (res.rows.length === 0) {
			await client.query("ROLLBACK");
			return null;
		}
		const edges: EdgeData[] = res.rows[0].edges;
		edges.push(edge);

		const updateRes = await client.query(
			`UPDATE workflows SET edges = $1::jsonb, updated_at = NOW() WHERE id = $2
			 RETURNING id, name, description, nodes, edges, visibility, created_at, updated_at`,
			[JSON.stringify(edges), workflowId],
		);
		await client.query("COMMIT");
		const r = updateRes.rows[0];
		return {
			...r,
			created_at: r.created_at?.toISOString?.() ?? r.created_at,
			updated_at: r.updated_at?.toISOString?.() ?? r.updated_at,
		};
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

export async function disconnectNodes(
	workflowId: string,
	edgeId: string,
): Promise<WorkflowRow | null> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const res = await client.query(
			`SELECT edges FROM workflows WHERE id = $1 FOR UPDATE`,
			[workflowId],
		);
		if (res.rows.length === 0) {
			await client.query("ROLLBACK");
			return null;
		}
		const edges: EdgeData[] = res.rows[0].edges.filter(
			(e: EdgeData) => e.id !== edgeId,
		);

		const updateRes = await client.query(
			`UPDATE workflows SET edges = $1::jsonb, updated_at = NOW() WHERE id = $2
			 RETURNING id, name, description, nodes, edges, visibility, created_at, updated_at`,
			[JSON.stringify(edges), workflowId],
		);
		await client.query("COMMIT");
		const r = updateRes.rows[0];
		return {
			...r,
			created_at: r.created_at?.toISOString?.() ?? r.created_at,
			updated_at: r.updated_at?.toISOString?.() ?? r.updated_at,
		};
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

// ── Execution Query Functions ─────────────────────────────

export type ExecutionRow = {
	id: string;
	workflowId: string;
	status: string;
	phase: string | null;
	error: string | null;
	startedAt: string;
	completedAt: string | null;
	duration: string | null;
};

export type ExecutionLogEntry = {
	id: string;
	nodeId: string;
	nodeName: string;
	nodeType: string;
	actionType: string | null;
	status: string;
	input: unknown;
	output: unknown;
	error: string | null;
	startedAt: string;
	completedAt: string | null;
	duration: string | null;
};

export async function getExecutionByInstanceId(
	instanceId: string,
): Promise<ExecutionRow | null> {
	const result = await pool.query(
		`SELECT id, workflow_id, status, phase, error, started_at, completed_at, duration
		 FROM workflow_executions WHERE dapr_instance_id = $1 LIMIT 1`,
		[instanceId],
	);
	if (result.rows.length === 0) return null;
	const r = result.rows[0];
	return {
		id: r.id,
		workflowId: r.workflow_id,
		status: r.status,
		phase: r.phase,
		error: r.error,
		startedAt: r.started_at?.toISOString?.() ?? r.started_at,
		completedAt: r.completed_at?.toISOString?.() ?? r.completed_at ?? null,
		duration: r.duration,
	};
}

export async function getExecutionLogs(
	executionId: string,
): Promise<ExecutionLogEntry[]> {
	const result = await pool.query(
		`SELECT id, node_id, node_name, node_type, activity_name, status,
				input, output, error, started_at, completed_at, duration
		 FROM workflow_execution_logs
		 WHERE execution_id = $1
		 ORDER BY started_at ASC`,
		[executionId],
	);
	return result.rows.map((r) => ({
		id: r.id,
		nodeId: r.node_id,
		nodeName: r.node_name,
		nodeType: r.node_type,
		actionType: r.activity_name ?? null,
		status: r.status,
		input: r.input,
		output: r.output,
		error: r.error,
		startedAt: r.started_at?.toISOString?.() ?? r.started_at,
		completedAt: r.completed_at?.toISOString?.() ?? r.completed_at ?? null,
		duration: r.duration,
	}));
}

export async function listAvailableActions(
	search?: string,
): Promise<ActionSummary[]> {
	const results: ActionSummary[] = [];

	// Builtin functions from functions table
	const funcQuery = search
		? `SELECT slug, name, description, plugin_id as category FROM functions
		   WHERE is_enabled = true AND (slug ILIKE $1 OR name ILIKE $1 OR description ILIKE $1)
		   ORDER BY slug`
		: `SELECT slug, name, description, plugin_id as category FROM functions
		   WHERE is_enabled = true ORDER BY slug`;
	const funcParams = search ? [`%${search}%`] : [];
	const funcResult = await pool.query(funcQuery, funcParams);
	for (const row of funcResult.rows) {
		results.push({
			slug: row.slug,
			name: row.name,
			description: row.description,
			category: row.category,
			source: "builtin",
		});
	}

	// Piece actions from piece_metadata table
	const pieceQuery = search
		? `SELECT name, display_name, actions FROM piece_metadata
		   WHERE display_name ILIKE $1 OR name ILIKE $1
		   ORDER BY display_name`
		: `SELECT name, display_name, actions FROM piece_metadata ORDER BY display_name`;
	const pieceParams = search ? [`%${search}%`] : [];
	const pieceResult = await pool.query(pieceQuery, pieceParams);
	for (const row of pieceResult.rows) {
		if (!row.actions) continue;
		const actions = row.actions as Record<
			string,
			{ displayName?: string; description?: string }
		>;
		for (const [key, action] of Object.entries(actions)) {
			const slug = `${row.name}/${key}`;
			if (
				search &&
				!slug.toLowerCase().includes(search.toLowerCase()) &&
				!(action.displayName ?? "")
					.toLowerCase()
					.includes(search.toLowerCase()) &&
				!(action.description ?? "").toLowerCase().includes(search.toLowerCase())
			) {
				continue;
			}
			results.push({
				slug,
				name: action.displayName ?? key,
				description: action.description ?? null,
				category: row.display_name,
				source: "piece",
			});
		}
	}

	return results;
}
