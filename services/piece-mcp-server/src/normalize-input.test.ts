import { describe, expect, it } from "vitest";

import { normalizeActionInput } from "./normalize-input";

const uploadAction = {
	props: {
		fileName: { type: "SHORT_TEXT" },
		file: { type: "FILE" },
	},
};

const getWorksheetsAction = {
	props: {
		workbook: { type: "DROPDOWN", displayName: "Workbook" },
		returnAll: { type: "CHECKBOX", displayName: "Return All" },
	},
};

const getRangeAction = {
	props: {
		workbook_id: { type: "DROPDOWN", displayName: "Workbook" },
		worksheet_id: { type: "DROPDOWN", displayName: "Worksheet" },
		range: { type: "SHORT_TEXT" },
	},
};

describe("normalizeActionInput", () => {
	it("parses FILE props passed as JSON strings", async () => {
		const normalized = await normalizeActionInput(uploadAction, {
			fileName: "report.xlsx",
			file: JSON.stringify({
				base64: "UEsDBAo=",
				data: "UEsDBAo=",
				extension: "xlsx",
			}),
		});

		expect(normalized.file).toEqual({
			base64: "UEsDBAo=",
			data: "UEsDBAo=",
			extension: "xlsx",
		});
	});

	it("parses FILE props passed as Python-style dict strings", async () => {
		const normalized = await normalizeActionInput(uploadAction, {
			fileName: "report.xlsx",
			file: "{'base64': 'UEsDBAo=', 'data': 'UEsDBAo=', 'extension': 'xlsx'}",
		});

		expect(normalized.file).toEqual({
			base64: "UEsDBAo=",
			data: "UEsDBAo=",
			extension: "xlsx",
		});
	});

	it("fills FILE data and extension from object input", async () => {
		const normalized = await normalizeActionInput(uploadAction, {
			fileName: "report.xlsx",
			file: { base64: "UEsDBAo=" },
		});

		expect(normalized.file).toEqual({
			base64: "UEsDBAo=",
			data: "UEsDBAo=",
			extension: "xlsx",
		});
	});

	it("parses FILE props passed as data URIs", async () => {
		const normalized = await normalizeActionInput(uploadAction, {
			file: "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,UEsDBAo=",
		});

		expect(normalized.file).toEqual({
			base64: "UEsDBAo=",
			data: "UEsDBAo=",
			extension: "xlsx",
		});
	});

	it("maps common Excel workbook aliases", async () => {
		const normalized = await normalizeActionInput(getWorksheetsAction, {
			workbookId: "workbook-123",
			returnAll: "True",
		});

		expect(normalized.workbook).toBe("workbook-123");
		expect(normalized.returnAll).toBe(true);
	});

	it("maps common Excel workbook and worksheet aliases for range actions", async () => {
		const normalized = await normalizeActionInput(getRangeAction, {
			workbookId: "workbook-123",
			worksheetId: "worksheet-456",
			range: "A1:C5",
		});

		expect(normalized.workbook_id).toBe("workbook-123");
		expect(normalized.worksheet_id).toBe("worksheet-456");
	});
});
