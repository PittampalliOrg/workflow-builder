export function shouldProvisionFarmBrowser({
	executionId,
	farmConfigured,
	laneExists,
}) {
	return Boolean(executionId && farmConfigured && !laneExists);
}

export function shouldCloseBrowserAfterCapture(reason) {
	return reason !== "close";
}
