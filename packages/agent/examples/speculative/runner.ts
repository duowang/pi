import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { streamSimple } from "../../../ai/src/api/openai-completions.ts";
import { streamSimple as streamResponses } from "../../../ai/src/api/openai-responses.ts";
import { Agent } from "../../src/agent.ts";
import { type SpeculationRecord, SpeculativeStream } from "../../src/speculation.ts";
import type { AgentTool, StreamFn } from "../../src/types.ts";

export const PASS = '{"status":"passed"}';
export interface Task {
	name: string;
	prompt: string;
	files: Record<string, string>;
	solution: string;
	test: string;
}
export interface Settings {
	provider: "cerebras" | "openrouter" | "openai";
	model: string;
	reasoning?: "low" | "medium" | "high";
	routing: string;
	latencyMs: number;
	maxTurns: number;
	timeoutMs: number;
	speculative: boolean;
	mismatchPolicy?: "cancel" | "drain";
}
export interface RunResult {
	task: string;
	speculative: boolean;
	latencyMs: number;
	wallMs: number;
	passed: boolean;
	testsRun: number;
	turns: number;
	error?: string;
	workspace: string;
	requests: { ms: number; input: number; output: number; stopReason: string; promptHash: string }[];
	speculations: SpeculationRecord[];
	tools: { name: string; ms: number }[];
}

/** Execute untrusted generated Python without provider credentials or network access. */
export async function grade(task: Task, solution: string, signal?: AbortSignal) {
	if (process.platform !== "darwin")
		throw new Error(
			"This runner currently requires macOS sandbox-exec. Use an isolated container on other platforms.",
		);
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-spec-grade-")));
	await writeFile(join(cwd, task.solution), solution);
	await writeFile(join(cwd, task.test), task.files[task.test]);
	const python = process.env.PYTHON_BIN ?? execFileSync("/usr/bin/which", ["python3"], { encoding: "utf8" }).trim();
	const profile = `(version 1)
(deny default)
(import "system.sb")
(allow syscall* mach-bootstrap)
(allow process* sysctl-read mach-lookup file-map-executable)
(allow file-read-metadata)
(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/Library") (subpath "/opt/homebrew") (subpath "/dev") (subpath ${JSON.stringify(cwd)}))
(allow file-write* (subpath ${JSON.stringify(cwd)}) (literal "/dev/null"))`;
	const args = ["-p", profile, python, "-B", "-m", "unittest", "discover", "-s", ".", "-p", task.test];
	const result = await new Promise<{ code: number; output: string }>((resolveResult, reject) => {
		const child = spawn("/usr/bin/sandbox-exec", args, {
			cwd,
			signal,
			env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: cwd, PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0" },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		let output = "";
		const capture = (data: Buffer) => {
			output = (output + data.toString()).slice(-24000);
		};
		child.stdout.on("data", capture);
		child.stderr.on("data", capture);
		const timer = setTimeout(() => {
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {}
			}
		}, 15_000);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolveResult({ code: code ?? -1, output: signal ? `${output}\nProcess terminated by ${signal}` : output });
		});
	});
	// A clean exit without executing tests is not a passing grade.
	const testsRun = Number(/Ran (\d+) tests?/.exec(result.output)?.[1] ?? 0);
	const passed = result.code === 0 && testsRun > 0 && /\nOK\s*$/.test(result.output);
	await rm(cwd, { recursive: true, force: true });
	return { ...result, output: result.output.replaceAll(cwd, "<workspace>"), testsRun, passed };
}

export async function runTask(
	task: Task,
	settings: Settings,
	outputDir: string,
	backend?: StreamFn,
): Promise<RunResult> {
	await mkdir(outputDir, { recursive: true });
	const workspace = await realpath(await mkdtemp(join(tmpdir(), "pi-spec-work-")));
	for (const [name, contents] of Object.entries(task.files)) await writeFile(join(workspace, name), contents);
	const requests: RunResult["requests"] = [];
	const speculations: SpeculationRecord[] = [];
	const toolTimes: RunResult["tools"] = [];
	const apiKey = process.env[`${settings.provider.toUpperCase()}_API_KEY`];
	if (!apiKey && !backend) throw new Error(`Missing ${settings.provider.toUpperCase()}_API_KEY`);
	const model: Model<"openai-completions" | "openai-responses"> = {
		id: settings.model,
		name: settings.model,
		api: settings.provider === "openai" ? "openai-responses" : "openai-completions",
		provider: settings.provider,
		baseUrl:
			settings.provider === "openai"
				? "https://api.openai.com/v1"
				: settings.provider === "cerebras"
					? "https://api.cerebras.ai/v1"
					: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		contextWindow: settings.provider === "openai" ? 1050000 : 131072,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {
			supportsDeveloperRole: settings.provider === "openai",
			...(settings.provider === "openrouter"
				? { openRouterRouting: { only: [settings.routing], allow_fallbacks: false } }
				: {}),
		},
	};
	const outstanding: Promise<unknown>[] = [];
	const delegate: StreamFn = async (selectedModel, context, options) => {
		const started = performance.now();
		const inferenceOptions = {
			...options,
			apiKey,
			maxTokens: 8192,
			reasoning: settings.reasoning ?? "low",
			maxRetries: 0,
		} as const;
		const stream = backend
			? await backend(selectedModel, context, options)
			: selectedModel.api === "openai-responses"
				? streamResponses(selectedModel as Model<"openai-responses">, context, inferenceOptions)
				: streamSimple(selectedModel as Model<"openai-completions">, context, {
						...inferenceOptions,
						temperature: 0,
					});
		outstanding.push(
			stream.result().then((result) => {
				requests.push({
					ms: performance.now() - started,
					input: result.usage.input,
					output: result.usage.output,
					stopReason: result.stopReason,
					promptHash: createHash("sha256").update(JSON.stringify(context)).digest("hex"),
				});
			}),
		);
		return stream;
	};
	const speculation = new SpeculativeStream(delegate, {
		enabled: settings.speculative,
		timeoutMs: 45_000,
		mismatchPolicy: settings.mismatchPolicy,
		predict: ({ toolCall }) =>
			toolCall.name === "run_tests" ? { content: [{ type: "text", text: PASS }], isError: false } : undefined,
		onRecord: (record) => speculations.push(record),
	});
	const readSchema = Type.Object({ path: Type.String() });
	const writeSchema = Type.Object({ path: Type.String(), content: Type.String() });
	const tools: AgentTool[] = [
		{
			name: "read",
			label: "read",
			description: "Read an available task file.",
			parameters: readSchema,
			execute: async (_id, params) => {
				const args = params as { path: string };
				if (!Object.hasOwn(task.files, args.path) || basename(args.path) !== args.path)
					throw new Error("File is not available");
				return {
					content: [{ type: "text", text: await readFile(join(workspace, args.path), "utf8") }],
					details: {},
				};
			},
		},
		{
			name: "write",
			label: "write",
			description: `Replace the solution file ${task.solution}. Tests are read-only.`,
			parameters: writeSchema,
			execute: async (_id, params) => {
				const args = params as { path: string; content: string };
				if (args.path !== task.solution) throw new Error("Only the solution file can be changed");
				await writeFile(join(workspace, task.solution), args.content);
				return { content: [{ type: "text", text: "Written." }], details: {} };
			},
		},
		{
			name: "run_tests",
			label: "run_tests",
			description:
				"Run the task's original test suite against the current solution. Passing returns a status; failures include diagnostics.",
			parameters: Type.Object({}),
			execute: async (_id, _args, signal) => {
				const result = await grade(task, await readFile(join(workspace, task.solution), "utf8"), signal);
				if (settings.latencyMs) await sleep(settings.latencyMs, undefined, { signal });
				return {
					content: [
						{
							type: "text",
							text: result.passed ? PASS : JSON.stringify({ status: "failed", diagnostics: result.output }),
						},
					],
					details: result,
					isError: !result.passed,
				};
			},
		},
	];
	let turns = 0;
	const agent = new Agent({
		initialState: {
			model,
			thinkingLevel: settings.reasoning ?? "low",
			tools,
			systemPrompt:
				"You are a coding agent. Implement the requested solution using the available tools. Read the specification, stub and tests. Write a complete implementation, run tests, and fix failures. Never modify tests. Call one tool at a time. Finish with a concise factual summary after tests pass.",
		},
		streamFn: speculation.stream,
		beforeToolCall: speculation.beforeToolCall,
		toolExecution: "sequential",
		finishTurn: () => {
			turns++;
			return turns >= settings.maxTurns ? { action: "end" } : undefined;
		},
	});
	const startedTools = new Map<string, number>();
	agent.subscribe((event) => {
		if (event.type === "tool_execution_start") startedTools.set(event.toolCallId, performance.now());
		if (event.type === "tool_execution_end")
			toolTimes.push({
				name: event.toolName,
				ms: performance.now() - (startedTools.get(event.toolCallId) ?? performance.now()),
			});
	});
	const start = performance.now();
	const timeout = setTimeout(() => agent.abort(), settings.timeoutMs);
	try {
		await agent.prompt(task.prompt);
	} finally {
		clearTimeout(timeout);
		speculation.dispose();
	}
	const wallMs = performance.now() - start;
	// Allow aborted calls to settle, but don't let a provider that ignores abort hang reporting.
	await Promise.race([Promise.allSettled(outstanding), sleep(1000)]);
	const solution = await readFile(join(workspace, task.solution), "utf8");
	const finalGrade = await grade(task, solution);
	const result: RunResult = {
		task: task.name,
		speculative: settings.speculative,
		latencyMs: settings.latencyMs,
		wallMs,
		passed: finalGrade.passed,
		testsRun: finalGrade.testsRun,
		turns,
		workspace,
		error: agent.state.errorMessage ?? (finalGrade.testsRun === 0 ? "Grader executed no tests" : undefined),
		requests,
		speculations,
		tools: toolTimes,
	};
	await writeFile(join(outputDir, "transcript.json"), JSON.stringify(agent.state.messages, null, 2));
	await writeFile(join(outputDir, task.solution), solution);
	await writeFile(join(outputDir, "grade.json"), JSON.stringify(finalGrade, null, 2));
	await writeFile(join(outputDir, "result.json"), JSON.stringify(result, null, 2));
	return result;
}

export async function loadTask(root: string, name: string): Promise<Task> {
	if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("Invalid exercise name");
	const folder = resolve(root, "python/exercises/practice", name);
	const module = name.replaceAll("-", "_");
	const solution = `${module}.py`;
	const test = `${module}_test.py`;
	const instructions = await readFile(join(folder, ".docs/instructions.md"), "utf8");
	return {
		name,
		solution,
		test,
		files: {
			[solution]: await readFile(join(folder, solution), "utf8"),
			[test]: await readFile(join(folder, test), "utf8"),
			"instructions.md": instructions,
		},
		prompt: `Implement the ${name} exercise in ${solution}. Available files: instructions.md, ${solution}, ${test}. Read them with the read tool, implement the solution, and use run_tests to verify it.`,
	};
}
