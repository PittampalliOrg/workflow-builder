import { otelLogMixin } from "./otel.js";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, normalize } from "node:path";
import { promisify } from "node:util";
import cors from "@fastify/cors";
import Fastify from "fastify";
import ts from "typescript";
import { z } from "zod";
import { setSpanInput, setSpanOutput } from "./observability/content.js";

const execFileAsync = promisify(execFile);

const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "0.0.0.0";
const DEFAULT_TIMEOUT_MS = Number.parseInt(
	process.env.CODE_RUNTIME_TIMEOUT_MS || "60000",
	10,
);

const ExecuteRequestSchema = z.object({
	language: z.enum(["typescript", "python"]),
	source: z.string().min(1),
	entrypoint: z.string().min(1).default("main"),
	path: z.string().optional(),
	supporting_files: z.record(z.string(), z.string()).default({}),
	args: z.array(z.unknown()).default([]),
	dependencies: z.array(z.string().min(1)).default([]),
	timeout_ms: z.number().int().positive().max(300000).optional(),
});

const OptionsRequestSchema = z.object({
	language: z.enum(["typescript", "python"]),
	source: z.string().min(1),
	handler: z.string().min(1),
	path: z.string().optional(),
	supporting_files: z.record(z.string(), z.string()).default({}),
	input: z.record(z.string(), z.unknown()).default({}),
	dependencies: z.array(z.string().min(1)).default([]),
	search_value: z.string().optional(),
	timeout_ms: z.number().int().positive().max(300000).optional(),
});

const NODE_RUNNER = `
const fs = require("node:fs");
const modulePath = process.argv[1];
const entrypoint = process.argv[2];
const payloadPath = process.argv[3];

(async () => {
  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  const mod = require(modulePath);
  const direct = typeof mod[entrypoint] === "function" ? mod[entrypoint] : null;
  const defaultExport =
    typeof mod.default === "function" && (entrypoint === "default" || entrypoint === "main")
      ? mod.default
      : typeof mod.default?.[entrypoint] === "function"
        ? mod.default[entrypoint]
        : null;
  const fn = direct || defaultExport;

  if (!fn) {
    throw new Error(\`Entrypoint "\${entrypoint}" was not found in compiled module\`);
  }

  const args = Array.isArray(payload.args) ? payload.args : [];
  const result = await fn(...args);
  process.stdout.write(JSON.stringify({ result }));
})().catch((error) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
`.trim();

const PYTHON_RUNNER = `
import asyncio
import importlib
import json
import pathlib
import sys

module_name = sys.argv[1]
entrypoint = sys.argv[2]
payload_path = pathlib.Path(sys.argv[3])

module = importlib.import_module(module_name)

fn = getattr(module, entrypoint, None)
if fn is None:
    raise RuntimeError(f'Entrypoint "{entrypoint}" was not found in python module')

with payload_path.open("r", encoding="utf-8") as handle:
    payload = json.load(handle)
args = payload.get("args", [])
if not isinstance(args, list):
    raise RuntimeError("Python runtime payload must contain an args list")

if asyncio.iscoroutinefunction(fn):
    result = asyncio.run(fn(*args))
else:
    result = fn(*args)

sys.stdout.write(json.dumps({"result": result}))
`.trim();

const NODE_OPTIONS_RUNNER = `
const fs = require("node:fs");
const modulePath = process.argv[1];
const handler = process.argv[2];
const payloadPath = process.argv[3];

function normalizeOptions(result) {
  if (Array.isArray(result)) {
    return {
      options: result.map((item) =>
        item && typeof item === "object" && "label" in item && "value" in item
          ? { label: String(item.label), value: item.value }
          : { label: String(item), value: item }
      ),
    };
  }

  if (result && typeof result === "object") {
    const state = result;
    const options = Array.isArray(state.options)
      ? state.options.map((item) =>
          item && typeof item === "object" && "label" in item && "value" in item
            ? { label: String(item.label), value: item.value }
            : { label: String(item), value: item }
        )
      : [];
    return {
      options,
      disabled: Boolean(state.disabled),
      placeholder: typeof state.placeholder === "string" ? state.placeholder : undefined,
    };
  }

  return { options: [] };
}

(async () => {
  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  const mod = require(modulePath);
  const direct = typeof mod[handler] === "function" ? mod[handler] : null;
  const defaultExport =
    typeof mod.default === "function" && (handler === "default" || handler === "main")
      ? mod.default
      : typeof mod.default?.[handler] === "function"
        ? mod.default[handler]
        : null;
  const fn = direct || defaultExport;

  if (!fn) {
    throw new Error(\`Options handler "\${handler}" was not found in compiled module\`);
  }

  const input = payload.input && typeof payload.input === "object" ? payload.input : {};
  const ctx = {
    searchValue: typeof payload.searchValue === "string" ? payload.searchValue : "",
  };
  const result = await fn(input, ctx);
  process.stdout.write(JSON.stringify(normalizeOptions(result)));
})().catch((error) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
`.trim();

const PYTHON_OPTIONS_RUNNER = `
import asyncio
import importlib
import json
import pathlib
import sys

module_name = sys.argv[1]
handler = sys.argv[2]
payload_path = pathlib.Path(sys.argv[3])

module = importlib.import_module(module_name)

fn = getattr(module, handler, None)
if fn is None:
    raise RuntimeError(f'Options handler "{handler}" was not found in python module')

with payload_path.open("r", encoding="utf-8") as handle:
    payload = json.load(handle)
input_data = payload.get("input", {})
if not isinstance(input_data, dict):
    raise RuntimeError("Python options payload must contain an input object")
ctx = {
    "searchValue": payload.get("searchValue", "") if isinstance(payload.get("searchValue", ""), str) else "",
}

if asyncio.iscoroutinefunction(fn):
    result = asyncio.run(fn(input_data, ctx))
else:
    result = fn(input_data, ctx)

def normalize_options(value):
    if isinstance(value, list):
        normalized = []
        for item in value:
            if isinstance(item, dict) and "label" in item and "value" in item:
                normalized.append({"label": str(item["label"]), "value": item["value"]})
            else:
                normalized.append({"label": str(item), "value": item})
        return {"options": normalized}

    if isinstance(value, dict):
        options = value.get("options", [])
        normalized = []
        if isinstance(options, list):
            for item in options:
                if isinstance(item, dict) and "label" in item and "value" in item:
                    normalized.append({"label": str(item["label"]), "value": item["value"]})
                else:
                    normalized.append({"label": str(item), "value": item})
        output = {"options": normalized}
        if "disabled" in value:
            output["disabled"] = bool(value["disabled"])
        if isinstance(value.get("placeholder"), str):
            output["placeholder"] = value["placeholder"]
        return output

    return {"options": []}

sys.stdout.write(json.dumps(normalize_options(result)))
`.trim();

function formatTsDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
	return diagnostics
		.map((diagnostic) =>
			ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
		)
		.join("\n");
}

function safeRelativePath(value: string | undefined, fallback: string): string {
	const candidate = (value || fallback).trim() || fallback;
	const normalized = normalize(candidate).replace(/^(\.\.(\/|\\|$))+/, "");
	if (!normalized || normalized.startsWith("..") || isAbsolute(normalized)) {
		return fallback;
	}
	return normalized;
}

function jsOutputPathFor(sourcePath: string): string {
	const extension = extname(sourcePath);
	if (!extension) {
		return `${sourcePath}.js`;
	}
	return `${sourcePath.slice(0, -extension.length)}.js`;
}

function pythonModuleNameFor(sourcePath: string): string {
	const normalized = safeRelativePath(sourcePath, "main.py").replace(/\\/g, "/");
	const withoutExtension = normalized.endsWith(".py")
		? normalized.slice(0, -3)
		: normalized;
	const moduleName = withoutExtension.replace(/\//g, ".");
	return moduleName.endsWith(".__init__")
		? moduleName.slice(0, -(".__init__".length))
		: moduleName;
}

async function writeProjectFiles(
	rootDir: string,
	mainPath: string,
	source: string,
	supportingFiles: Record<string, string>,
): Promise<string[]> {
	const files = new Map<string, string>();
	files.set(mainPath, source);

	for (const [relativePath, contents] of Object.entries(supportingFiles)) {
		files.set(
			safeRelativePath(relativePath, relativePath),
			contents,
		);
	}

	const writtenFiles: string[] = [];
	for (const [relativePath, contents] of files.entries()) {
		const absolutePath = join(rootDir, relativePath);
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, contents, "utf8");
		writtenFiles.push(absolutePath);
	}
	return writtenFiles;
}

async function runTypeScriptProgram(input: {
	source: string;
	entrypoint: string;
	path?: string;
	supportingFiles: Record<string, string>;
	dependencies: string[];
	timeoutMs: number;
	payload: Record<string, unknown>;
	runner: string;
}): Promise<Record<string, unknown>> {
	const dir = await mkdtemp(join(tmpdir(), "code-runtime-ts-"));
	try {
		const sourceRoot = join(dir, "src");
		const outDir = join(dir, "dist");
		const mainPath = safeRelativePath(input.path, "main.ts");
		const payloadPath = join(dir, "payload.json");
		const compilerOptions: ts.CompilerOptions = {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.CommonJS,
			lib: ["lib.es2022.d.ts"],
			esModuleInterop: true,
			moduleResolution: ts.ModuleResolutionKind.NodeJs,
			resolveJsonModule: true,
			rootDir: sourceRoot,
			outDir,
		};
		const defaultLibFilePath = ts.getDefaultLibFilePath(compilerOptions);
		const defaultLibLocation = dirname(defaultLibFilePath);

		await writeProjectFiles(sourceRoot, mainPath, input.source, input.supportingFiles);

		if (input.dependencies.length > 0) {
			await writeFile(
				join(dir, "package.json"),
				JSON.stringify({ name: "code-runtime-temp", private: true }, null, 2),
				"utf8",
			);
			await execFileAsync(
				"npm",
				[
					"install",
					"--no-save",
					"--fund=false",
					"--audit=false",
					...input.dependencies,
				],
				{
					cwd: dir,
					timeout: input.timeoutMs,
					maxBuffer: 10 * 1024 * 1024,
				},
			);
		}

		const compilerHost = ts.createCompilerHost(compilerOptions);
		compilerHost.getDefaultLibLocation = () => defaultLibLocation;
		compilerHost.getDefaultLibFileName = () =>
			defaultLibFilePath.split(/[/\\]/).pop() || "lib.es2022.d.ts";
		const rootNames = Object.keys({
			[safeRelativePath(input.path, "main.ts")]: true,
			...Object.fromEntries(
				Object.keys(input.supportingFiles).map((path) => [safeRelativePath(path, path), true]),
			),
		}).map((relativePath) => join(sourceRoot, relativePath));
		const program = ts.createProgram(
			rootNames,
			compilerOptions,
			compilerHost,
		);
		const emitResult = program.emit();
		const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
		const errors = diagnostics.filter(
			(item) => item.category === ts.DiagnosticCategory.Error,
		);
		if (errors.length > 0) {
			throw new Error(formatTsDiagnostics(errors));
		}

		const modulePath = join(outDir, jsOutputPathFor(mainPath));
		await writeFile(payloadPath, JSON.stringify(input.payload), "utf8");

		const { stdout } = await execFileAsync(
			process.execPath,
			["-e", input.runner, modulePath, input.entrypoint, payloadPath],
			{ timeout: input.timeoutMs, maxBuffer: 10 * 1024 * 1024 },
		);

		return JSON.parse(stdout || "{}") as Record<string, unknown>;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function runTypeScript(input: {
	source: string;
	entrypoint: string;
	path?: string;
	supportingFiles: Record<string, string>;
	args: unknown[];
	dependencies: string[];
	timeoutMs: number;
}): Promise<unknown> {
	const parsed = await runTypeScriptProgram({
		source: input.source,
		entrypoint: input.entrypoint,
		path: input.path,
		supportingFiles: input.supportingFiles,
		dependencies: input.dependencies,
		timeoutMs: input.timeoutMs,
		payload: { args: input.args },
		runner: NODE_RUNNER,
	});
	return parsed.result;
}

async function runTypeScriptOptions(input: {
	source: string;
	handler: string;
	path?: string;
	supportingFiles: Record<string, string>;
	inputValues: Record<string, unknown>;
	dependencies: string[];
	searchValue?: string;
	timeoutMs: number;
}) {
	return runTypeScriptProgram({
		source: input.source,
		entrypoint: input.handler,
		path: input.path,
		supportingFiles: input.supportingFiles,
		dependencies: input.dependencies,
		timeoutMs: input.timeoutMs,
		payload: {
			input: input.inputValues,
			searchValue: input.searchValue ?? "",
		},
		runner: NODE_OPTIONS_RUNNER,
	});
}

async function runPythonProgram(input: {
	source: string;
	entrypoint: string;
	path?: string;
	supportingFiles: Record<string, string>;
	dependencies: string[];
	timeoutMs: number;
	payload: Record<string, unknown>;
	runner: string;
}): Promise<Record<string, unknown>> {
	const dir = await mkdtemp(join(tmpdir(), "code-runtime-py-"));
	try {
		const mainPath = safeRelativePath(input.path, "main.py");
		const moduleName = pythonModuleNameFor(mainPath);
		const payloadPath = join(dir, "payload.json");
		const vendorPath = join(dir, "vendor");

		if (input.dependencies.length > 0) {
			await execFileAsync(
				"python3",
				[
					"-m",
					"pip",
					"install",
					"--disable-pip-version-check",
					"--no-input",
					"--target",
					vendorPath,
					...input.dependencies,
				],
				{
					timeout: input.timeoutMs,
					maxBuffer: 10 * 1024 * 1024,
				},
			);
		}

		await writeProjectFiles(dir, mainPath, input.source, input.supportingFiles);
		await writeFile(payloadPath, JSON.stringify(input.payload), "utf8");

		const { stdout } = await execFileAsync(
			"python3",
			["-c", input.runner, moduleName, input.entrypoint, payloadPath],
			{
				timeout: input.timeoutMs,
				maxBuffer: 10 * 1024 * 1024,
				env: {
					...process.env,
					PYTHONPATH: [dir, input.dependencies.length > 0 ? vendorPath : "", process.env.PYTHONPATH || ""]
						.filter((value) => value.length > 0)
						.join(":"),
				},
			},
		);

		return JSON.parse(stdout || "{}") as Record<string, unknown>;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function runPython(input: {
	source: string;
	entrypoint: string;
	path?: string;
	supportingFiles: Record<string, string>;
	args: unknown[];
	dependencies: string[];
	timeoutMs: number;
}): Promise<unknown> {
	const parsed = await runPythonProgram({
		source: input.source,
		entrypoint: input.entrypoint,
		path: input.path,
		supportingFiles: input.supportingFiles,
		dependencies: input.dependencies,
		timeoutMs: input.timeoutMs,
		payload: { args: input.args },
		runner: PYTHON_RUNNER,
	});
	return parsed.result;
}

async function runPythonOptions(input: {
	source: string;
	handler: string;
	path?: string;
	supportingFiles: Record<string, string>;
	inputValues: Record<string, unknown>;
	dependencies: string[];
	searchValue?: string;
	timeoutMs: number;
}) {
	return runPythonProgram({
		source: input.source,
		entrypoint: input.handler,
		path: input.path,
		supportingFiles: input.supportingFiles,
		dependencies: input.dependencies,
		timeoutMs: input.timeoutMs,
		payload: {
			input: input.inputValues,
			searchValue: input.searchValue ?? "",
		},
		runner: PYTHON_OPTIONS_RUNNER,
	});
}

async function main() {
	const app = Fastify({
		logger: {
			level: process.env.LOG_LEVEL || "info",
			mixin: otelLogMixin,
		},
		bodyLimit: 20 * 1024 * 1024,
	});

	await app.register(cors, {
		origin: true,
		methods: ["GET", "POST", "OPTIONS"],
	});

	app.addHook("onSend", async (_request, _reply, payload) => {
		setSpanOutput(payload);
		return payload;
	});

	app.get("/health", async () => ({ status: "healthy", service: "code-runtime" }));
	app.get("/healthz", async () => ({ status: "healthy", service: "code-runtime" }));
	app.get("/readyz", async () => ({ status: "ready", service: "code-runtime" }));

	app.get("/api/runtime/introspect", async () => ({
		service: "code-runtime",
		version: "1.0.0",
		runtime: "node-python-exec",
		ready: true,
		features: [
			"typescript",
			"python",
			"supporting-files",
			"external-dependencies",
			"dynamic-options",
		],
		registeredWorkflows: [],
		registeredActivities: [],
		errors: [],
	}));

	app.post("/options", async (request, reply) => {
		const parseResult = OptionsRequestSchema.safeParse(request.body);
		if (!parseResult.success) {
			return reply.status(400).send({
				error: "Validation failed",
				details: parseResult.error.issues,
				options: [],
			});
		}

		const body = parseResult.data;
		setSpanInput({
			language: body.language,
			handler: body.handler,
			path: body.path,
			input: body.input,
			search_value: body.search_value,
			dependencies: body.dependencies,
			timeout_ms: body.timeout_ms,
		});
		try {
			const timeoutMs = body.timeout_ms ?? DEFAULT_TIMEOUT_MS;
			const result =
				body.language === "python"
					? await runPythonOptions({
							source: body.source,
							handler: body.handler,
							path: body.path,
							supportingFiles: body.supporting_files,
							inputValues: body.input,
							dependencies: body.dependencies,
							searchValue: body.search_value,
							timeoutMs,
						})
					: await runTypeScriptOptions({
							source: body.source,
							handler: body.handler,
							path: body.path,
							supportingFiles: body.supporting_files,
							inputValues: body.input,
							dependencies: body.dependencies,
							searchValue: body.search_value,
							timeoutMs,
						});

			return reply.status(200).send(result);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: typeof error === "string"
						? error
						: "Code options evaluation failed";
			return reply.status(500).send({
				error: message,
				options: [],
			});
		}
	});

	app.post("/execute", async (request, reply) => {
		const parseResult = ExecuteRequestSchema.safeParse(request.body);
		if (!parseResult.success) {
			return reply.status(400).send({
				success: false,
				error: "Validation failed",
				details: parseResult.error.issues,
				duration_ms: 0,
			});
		}

		const body = parseResult.data;
		setSpanInput({
			language: body.language,
			entrypoint: body.entrypoint,
			path: body.path,
			args: body.args,
			dependencies: body.dependencies,
			timeout_ms: body.timeout_ms,
		});
		const startedAt = Date.now();

		try {
			const timeoutMs = body.timeout_ms ?? DEFAULT_TIMEOUT_MS;
			const data =
				body.language === "python"
					? await runPython({
							source: body.source,
							entrypoint: body.entrypoint,
							path: body.path,
							supportingFiles: body.supporting_files,
							args: body.args,
							dependencies: body.dependencies,
							timeoutMs,
						})
					: await runTypeScript({
							source: body.source,
							entrypoint: body.entrypoint,
							path: body.path,
							supportingFiles: body.supporting_files,
							args: body.args,
							dependencies: body.dependencies,
							timeoutMs,
						});

			return reply.status(200).send({
				success: true,
				data,
				duration_ms: Date.now() - startedAt,
			});
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: typeof error === "string"
						? error
						: "Code execution failed";
			return reply.status(200).send({
				success: false,
				error: message,
				duration_ms: Date.now() - startedAt,
			});
		}
	});

	await app.listen({ port: PORT, host: HOST });
	console.log(`code-runtime listening on ${HOST}:${PORT}`);
}

main().catch((error) => {
	console.error("[code-runtime] Fatal error:", error);
	process.exit(1);
});
