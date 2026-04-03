export interface PortPosition {
	x: number;
	y: number;
}

export function createPortCoordinateStore() {
	let ports = $state<Map<string, PortPosition>>(new Map());

	function registerPort(portId: string, x: number, y: number) {
		const newMap = new Map(ports);
		newMap.set(portId, { x, y });
		ports = newMap;
	}

	function unregisterPort(portId: string) {
		const newMap = new Map(ports);
		newMap.delete(portId);
		ports = newMap;
	}

	function getPortPosition(portId: string): PortPosition | undefined {
		return ports.get(portId);
	}

	return {
		get ports() { return ports; },
		registerPort,
		unregisterPort,
		getPortPosition
	};
}
