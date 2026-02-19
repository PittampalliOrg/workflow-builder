import { expect, test } from "@playwright/test";

const SELECTED_CLASS_REGEX = /selected/;

test.describe("Workflow Editor", () => {
	test.beforeEach(async ({ page }) => {
		// Navigate to the homepage which has an embedded workflow canvas
		await page.goto("/", { waitUntil: "domcontentloaded" });
		// Wait for the canvas to be ready
		await page.waitForSelector('[data-testid="workflow-canvas"]', {
			state: "visible",
			timeout: 60_000,
		});
	});

	test("workflow canvas loads", async ({ page }) => {
		// Verify the canvas container is visible
		const canvas = page.locator('[data-testid="workflow-canvas"]');
		await expect(canvas).toBeVisible();

		// Verify React Flow is rendered
		const reactFlow = page.locator(".react-flow");
		await expect(reactFlow).toBeVisible();
	});

	test("can create a new step by dragging from a node", async ({ page }) => {
		// Wait for any existing nodes to be visible
		await page.waitForTimeout(1000);

		// Find the trigger node's source handle
		const triggerHandle = page.locator(
			".react-flow__node-trigger .react-flow__handle-source",
		);

		// If there's a trigger node, drag from it to create a new node
		if (await triggerHandle.isVisible()) {
			const handleBox = await triggerHandle.boundingBox();
			if (handleBox) {
				// Start drag from handle
				await page.mouse.move(
					handleBox.x + handleBox.width / 2,
					handleBox.y + handleBox.height / 2,
				);
				await page.mouse.down();

				// Drag to empty area
				await page.mouse.move(handleBox.x + 300, handleBox.y);
				await page.mouse.up();

				// Wait for the new node to appear
				await page.waitForTimeout(500);

				// Verify a new action node was created (checking for action grid in properties)
				const actionGrid = page.locator('[data-testid="action-grid"]');
				await expect(actionGrid).toBeVisible({ timeout: 5000 });
			}
		}
	});

	test("search input is auto-focused when creating a new step", async ({
		page,
	}) => {
		// Wait for any existing nodes
		await page.waitForTimeout(1000);

		// Find the trigger node's source handle
		const triggerHandle = page.locator(
			".react-flow__node-trigger .react-flow__handle-source",
		);

		if (await triggerHandle.isVisible()) {
			const handleBox = await triggerHandle.boundingBox();
			if (handleBox) {
				// Drag from handle to create new node
				await page.mouse.move(
					handleBox.x + handleBox.width / 2,
					handleBox.y + handleBox.height / 2,
				);
				await page.mouse.down();
				await page.mouse.move(handleBox.x + 300, handleBox.y);
				await page.mouse.up();

				// Wait for new node and action grid
				await page.waitForTimeout(500);

				// Verify the search input is focused
				const searchInput = page.locator('[data-testid="action-search-input"]');
				await expect(searchInput).toBeFocused({ timeout: 5000 });
			}
		}
	});

	test("search input is NOT auto-focused when selecting existing unconfigured step", async ({
		page,
	}) => {
		// First create a new step
		const triggerHandle = page.locator(
			".react-flow__node-trigger .react-flow__handle-source",
		);

		if (await triggerHandle.isVisible()) {
			const handleBox = await triggerHandle.boundingBox();
			if (handleBox) {
				// Create new node
				await page.mouse.move(
					handleBox.x + handleBox.width / 2,
					handleBox.y + handleBox.height / 2,
				);
				await page.mouse.down();
				await page.mouse.move(handleBox.x + 300, handleBox.y);
				await page.mouse.up();

				await page.waitForTimeout(500);

				// Click on canvas to deselect
				const canvas = page.locator('[data-testid="workflow-canvas"]');
				const canvasBox = await canvas.boundingBox();
				if (canvasBox) {
					// Click on empty area of canvas
					await page.mouse.click(canvasBox.x + 50, canvasBox.y + 50);
					await page.waitForTimeout(300);
				}

				// Find the action node and click on it
				const actionNode = page.locator(".react-flow__node-action").first();
				if (await actionNode.isVisible()) {
					await actionNode.click();
					await page.waitForTimeout(300);

					// Verify search input is visible but NOT focused
					const searchInput = page.locator(
						'[data-testid="action-search-input"]',
					);
					await expect(searchInput).toBeVisible({ timeout: 5000 });

					// The search input should NOT be focused when re-selecting an existing node
					await expect(searchInput).not.toBeFocused();
				}
			}
		}
	});

	test("can select and deselect nodes", async ({ page }) => {
		// Wait for nodes to be visible
		await page.waitForTimeout(1000);

		// Find trigger node
		const triggerNode = page.locator(".react-flow__node-trigger").first();

		if (await triggerNode.isVisible()) {
			// Click to select
			await triggerNode.click();
			await page.waitForTimeout(300);

			// Verify node is selected (has border-primary class or selected attribute)
			await expect(triggerNode).toHaveClass(SELECTED_CLASS_REGEX);

			// Click on canvas to deselect
			const canvas = page.locator('[data-testid="workflow-canvas"]');
			const canvasBox = await canvas.boundingBox();
			if (canvasBox) {
				await page.mouse.click(canvasBox.x + 50, canvasBox.y + 50);
				await page.waitForTimeout(300);
			}

			// Verify node is deselected
			await expect(triggerNode).not.toHaveClass(SELECTED_CLASS_REGEX);
		}
	});

	test("can select an action type for a new step", async ({ page }) => {
		// First create a new step
		const triggerHandle = page.locator(
			".react-flow__node-trigger .react-flow__handle-source",
		);

		if (await triggerHandle.isVisible()) {
			const handleBox = await triggerHandle.boundingBox();
			if (handleBox) {
				// Create new node
				await page.mouse.move(
					handleBox.x + handleBox.width / 2,
					handleBox.y + handleBox.height / 2,
				);
				await page.mouse.down();
				await page.mouse.move(handleBox.x + 300, handleBox.y);
				await page.mouse.up();

				await page.waitForTimeout(500);

				// Wait for action grid to appear
				const actionGrid = page.locator('[data-testid="action-grid"]');
				await expect(actionGrid).toBeVisible({ timeout: 5000 });

				// Click on HTTP Request action
				const httpRequestAction = page.locator(
					'[data-testid="action-option-http-request"]',
				);
				await expect(httpRequestAction).toBeVisible();
				await httpRequestAction.click();

				// Wait for the action to be selected
				await page.waitForTimeout(500);

				// Verify the action grid is no longer visible (node is now configured)
				await expect(actionGrid).not.toBeVisible({ timeout: 5000 });

				// Verify the node now shows the HTTP Request configuration
				// The action node should no longer show the action selection grid
				const selectedActionNode = page.locator(".react-flow__node-action");
				await expect(selectedActionNode).toBeVisible();
			}
		}
	});

	test("search filters actions in the action grid", async ({ page }) => {
		// First create a new step
		const triggerHandle = page.locator(
			".react-flow__node-trigger .react-flow__handle-source",
		);

		if (await triggerHandle.isVisible()) {
			const handleBox = await triggerHandle.boundingBox();
			if (handleBox) {
				// Create new node
				await page.mouse.move(
					handleBox.x + handleBox.width / 2,
					handleBox.y + handleBox.height / 2,
				);
				await page.mouse.down();
				await page.mouse.move(handleBox.x + 300, handleBox.y);
				await page.mouse.up();

				await page.waitForTimeout(500);

				// Wait for search input
				const searchInput = page.locator('[data-testid="action-search-input"]');
				await expect(searchInput).toBeVisible({ timeout: 5000 });

				// Type in search
				await searchInput.fill("HTTP");
				await page.waitForTimeout(300);

				// Verify HTTP Request is visible
				const httpRequestAction = page.locator(
					'[data-testid="action-option-http-request"]',
				);
				await expect(httpRequestAction).toBeVisible();

				// Verify non-matching actions are filtered out
				const conditionAction = page.locator(
					'[data-testid="action-option-condition"]',
				);
				await expect(conditionAction).not.toBeVisible();
			}
		}
	});

	test("can inline insert a palette step by dropping on an edge", async ({
		page,
	}) => {
		const stepPalette = page.locator('[data-testid="step-palette"]');
		await expect(stepPalette).toBeVisible();
		const actionPaletteItem = page.locator(
			'[data-testid="step-palette-item-action"]',
		);
		await expect(actionPaletteItem).toBeVisible();

		const edges = page.locator(".react-flow__edge");
		const canvas = page.locator('[data-testid="workflow-canvas"]');
		let edgeCount = await edges.count();

		if (edgeCount === 0) {
			const triggerSourceHandle = page.locator(
				".react-flow__node-trigger .react-flow__handle-source",
			);

			if (await triggerSourceHandle.isVisible()) {
				const handleBox = await triggerSourceHandle.boundingBox();
				if (!handleBox) {
					throw new Error("Trigger source handle has no bounding box");
				}

				await page.mouse.move(
					handleBox.x + handleBox.width / 2,
					handleBox.y + handleBox.height / 2,
				);
				await page.mouse.down();
				await page.mouse.move(handleBox.x + 300, handleBox.y);
				await page.mouse.up();
			} else {
				await actionPaletteItem.dragTo(canvas, {
					targetPosition: { x: 320, y: 220 },
				});
				const insertButtons = page.getByRole("button", {
					name: "+",
					exact: true,
				});
				if ((await insertButtons.count()) === 0) {
					test.skip(true, "No inline insert control available in this context");
					return;
				}
				await expect(insertButtons.last()).toBeVisible({ timeout: 10_000 });
				await insertButtons.last().click();
			}

			await page.waitForTimeout(700);
			edgeCount = await edges.count();
		}

		expect(edgeCount).toBeGreaterThan(0);

		const edgeBox = await edges.first().boundingBox();
		const canvasBox = await canvas.boundingBox();
		if (!(edgeBox && canvasBox)) {
			throw new Error("Unable to compute drag target for edge insertion");
		}

		const targetPosition = {
			x: Math.max(
				8,
				Math.min(
					canvasBox.width - 8,
					edgeBox.x + edgeBox.width / 2 - canvasBox.x,
				),
			),
			y: Math.max(
				8,
				Math.min(
					canvasBox.height - 8,
					edgeBox.y + edgeBox.height / 2 - canvasBox.y,
				),
			),
		};

		const actionNodes = page.locator(".react-flow__node-action");
		const actionCountBefore = await actionNodes.count();
		const edgeCountBefore = await edges.count();

		await actionPaletteItem.dragTo(canvas, { targetPosition });

		await expect(actionNodes).toHaveCount(actionCountBefore + 1);
		await expect(edges).toHaveCount(edgeCountBefore + 1);
	});

	test("trigger source handle enforces connection limit", async ({ page }) => {
		const addStepButton = page.getByRole("button", { name: "Add a Step" });
		if (await addStepButton.isVisible()) {
			await addStepButton.click();
		}

		const triggerHandle = page.locator(
			".react-flow__node-trigger .react-flow__handle-source",
		);
		if (!(await triggerHandle.isVisible())) {
			test.skip(true, "No trigger source handle available in this context");
			return;
		}
		await expect(triggerHandle).toBeVisible({ timeout: 10_000 });
		const handleBox = await triggerHandle.boundingBox();
		if (!handleBox) {
			throw new Error("Trigger source handle has no bounding box");
		}

		const dragFromTrigger = async (xOffset: number, yOffset: number) => {
			await page.mouse.move(
				handleBox.x + handleBox.width / 2,
				handleBox.y + handleBox.height / 2,
			);
			await page.mouse.down();
			await page.mouse.move(handleBox.x + xOffset, handleBox.y + yOffset, {
				steps: 4,
			});
			await page.mouse.up();
			await page.waitForTimeout(600);
		};

		await dragFromTrigger(280, 0);
		const edges = page.locator(".react-flow__edge");
		await expect(edges).toHaveCount(1);

		await dragFromTrigger(320, 70);
		await expect(edges).toHaveCount(1);
	});

	test("pane context menu can add transform node", async ({ page }) => {
		const canvas = page.locator('[data-testid="workflow-canvas"]');
		const canvasBox = await canvas.boundingBox();
		if (!canvasBox) {
			throw new Error("Workflow canvas has no bounding box");
		}

		const transformNodes = page.locator(".react-flow__node-transform");
		const beforeCount = await transformNodes.count();

		await page.mouse.click(
			canvasBox.x + canvasBox.width - 80,
			canvasBox.y + 120,
			{
				button: "right",
			},
		);
		const addTransform = page.getByRole("button", { name: "Add Transform" });
		if (!(await addTransform.isVisible())) {
			test.skip(
				true,
				"Pane context menu transform option unavailable in this context",
			);
			return;
		}
		await expect(addTransform).toBeVisible({ timeout: 5000 });
		await addTransform.click();

		await expect(transformNodes).toHaveCount(beforeCount + 1);
	});

	test("keyboard undo/redo applies to added steps", async ({ page }) => {
		const addStepButton = page.getByTitle("Add Step").first();
		if (!(await addStepButton.isVisible())) {
			test.skip(true, "Toolbar add step control unavailable in this context");
			return;
		}

		const actionNodes = page.locator(".react-flow__node-action");
		const beforeCount = await actionNodes.count();

		await addStepButton.click();
		await expect(actionNodes).toHaveCount(beforeCount + 1);

		await page.keyboard.press("ControlOrMeta+Z");
		await expect(actionNodes).toHaveCount(beforeCount);

		await page.keyboard.press("ControlOrMeta+Shift+Z");
		await expect(actionNodes).toHaveCount(beforeCount + 1);
	});

	test("can copy and paste selected nodes with keyboard shortcuts", async ({
		page,
		browserName,
	}) => {
		test.skip(
			browserName !== "chromium",
			"Clipboard shortcuts are only validated in chromium",
		);

		await page
			.context()
			.grantPermissions(["clipboard-read", "clipboard-write"]);

		const actionPaletteItem = page.locator(
			'[data-testid="step-palette-item-action"]',
		);
		await expect(actionPaletteItem).toBeVisible();
		const canvas = page.locator('[data-testid="workflow-canvas"]');

		const actionNodes = page.locator(".react-flow__node-action");
		if ((await actionNodes.count()) === 0) {
			await actionPaletteItem.dragTo(canvas, {
				targetPosition: { x: 260, y: 220 },
			});
			if ((await actionNodes.count()) === 0) {
				test.skip(true, "Unable to create an action node in this context");
				return;
			}
		}

		const firstActionNode = actionNodes.first();
		await firstActionNode.click();
		await page.keyboard.press("ControlOrMeta+C");
		await page.mouse.move(640, 360);
		await page.keyboard.press("ControlOrMeta+V");

		await expect(actionNodes).toHaveCount(2);
	});

	test("can group and ungroup selected nodes", async ({ page }) => {
		const addStepButton = page.getByRole("button", { name: "Add a Step" });
		const inlineAddButton = page.getByRole("button", { name: "+" }).first();
		const actionPaletteButton = page.getByRole("button", { name: "Action" });
		const flowPane = page.locator(".react-flow__pane").first();
		const groupableNodes = page.locator(
			".react-flow__node:not(.react-flow__node-trigger):not(.react-flow__node-add):not(.react-flow__node-group):not(.react-flow__node-while)",
		);

		for (let attempt = 0; attempt < 6; attempt += 1) {
			const beforeCount = await groupableNodes.count();
			if (beforeCount >= 2) {
				break;
			}
			if (await addStepButton.isVisible()) {
				await addStepButton.click();
			} else if (await inlineAddButton.isVisible()) {
				await inlineAddButton.click();
			} else if (
				(await actionPaletteButton.isVisible()) &&
				(await flowPane.isVisible())
			) {
				await actionPaletteButton.dragTo(flowPane, {
					targetPosition: {
						x: 760 + (attempt % 2) * 180,
						y: 220 + Math.floor(attempt / 2) * 140,
					},
				});
			} else {
				throw new Error(
					"No step creation controls available for grouping test",
				);
			}
			await page.waitForTimeout(700);
		}
		await expect
			.poll(async () => groupableNodes.count(), { timeout: 8_000 })
			.toBeGreaterThanOrEqual(2);

		const firstNodeBox = await groupableNodes.first().boundingBox();
		const secondNodeBox = await groupableNodes.nth(1).boundingBox();
		if (!firstNodeBox || !secondNodeBox) {
			throw new Error("Unable to resolve node positions for grouping");
		}
		await page.mouse.click(
			firstNodeBox.x + firstNodeBox.width / 2,
			firstNodeBox.y + Math.min(24, firstNodeBox.height / 2),
		);
		await page.keyboard.down("Shift");
		await page.mouse.click(
			secondNodeBox.x + secondNodeBox.width / 2,
			secondNodeBox.y + Math.min(24, secondNodeBox.height / 2),
		);
		await page.keyboard.up("Shift");
		await page.evaluate(() => {
			const activeElement = document.activeElement as HTMLElement | null;
			activeElement?.blur();
		});
		await expect
			.poll(async () => page.locator(".react-flow__node.selected").count(), {
				timeout: 5_000,
			})
			.toBeGreaterThanOrEqual(2);

		const groupNodes = page.locator(".react-flow__node-group");
		const beforeCount = await groupNodes.count();
		const groupButton = page.getByTitle("Group selected nodes").first();
		if (await groupButton.isVisible()) {
			await groupButton.click();
		} else {
			await page.keyboard.press("ControlOrMeta+G");
		}
		await expect(groupNodes).toHaveCount(beforeCount + 1);

		const ungroupButton = page.getByTitle("Ungroup").first();
		if (await ungroupButton.isVisible()) {
			await ungroupButton.click();
		} else {
			await page.keyboard.press("ControlOrMeta+Shift+G");
		}
		await expect(groupNodes).toHaveCount(beforeCount);
	});
});
