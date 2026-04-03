/**
 * Proximity connect helper — find the nearest compatible port when dragging a node.
 * Inspired by Flowdrop's proximityConnect.ts pattern.
 */

/** Port position data from portCoordinateStore */
export interface PortPosition {
	nodeId: string;
	portId: string;
	x: number;
	y: number;
	type: 'source' | 'target';
}

export interface ProximityMatch {
	targetNodeId: string;
	targetPortId: string;
	distance: number;
}

/**
 * Find the nearest compatible port on another node within maxDistance.
 *
 * When a user drags a node, call this with the dragged node's source ports
 * to highlight the closest target port that could accept a connection.
 *
 * @param draggedNodeId - The node currently being dragged
 * @param portPositions - All port positions from portCoordinateStore
 * @param maxDistance - Maximum pixel distance to consider (default 100)
 * @returns The closest compatible port match, or null if none within range
 */
export function findNearestCompatiblePort(
	draggedNodeId: string,
	portPositions: PortPosition[],
	maxDistance = 100
): ProximityMatch | null {
	// Get source ports belonging to the dragged node
	const sourcePorts = portPositions.filter(
		(p) => p.nodeId === draggedNodeId && p.type === 'source'
	);

	// Get target ports on other nodes
	const candidateTargets = portPositions.filter(
		(p) => p.nodeId !== draggedNodeId && p.type === 'target'
	);

	let bestMatch: ProximityMatch | null = null;
	let bestDistance = maxDistance;

	for (const source of sourcePorts) {
		for (const target of candidateTargets) {
			const dx = source.x - target.x;
			const dy = source.y - target.y;
			const distance = Math.sqrt(dx * dx + dy * dy);

			if (distance < bestDistance) {
				bestDistance = distance;
				bestMatch = {
					targetNodeId: target.nodeId,
					targetPortId: target.portId,
					distance
				};
			}
		}
	}

	return bestMatch;
}
