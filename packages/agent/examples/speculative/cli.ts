import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { StreamFn } from "../../src/types.ts";
import { grade, loadTask, type RunResult, runTask, type Settings } from "./runner.ts";
import { subscriptionModels } from "./subscription.ts";

const { values } = parseArgs({
	options: {
		dataset: { type: "string", default: "../pi-benchmark-tasks" },
		tasks: { type: "string", default: "wordy,grade-school,phone-number,transpose,forth,bowling" },
		repeats: { type: "string", default: "2" },
		latencies: { type: "string", default: "0,2000" },
		mode: { type: "string", default: "both" },
		"mismatch-policy": { type: "string", default: "drain" },
		provider: { type: "string", default: "openrouter" },
		auth: { type: "string", default: "api-key" },
		model: { type: "string", default: "openai/gpt-oss-120b" },
		reasoning: { type: "string", default: "low" },
		routing: { type: "string", default: "cerebras" },
		output: { type: "string", default: `.artifacts/speculation/${new Date().toISOString().replaceAll(":", "-")}` },
		"max-turns": { type: "string", default: "16" },
		"timeout-seconds": { type: "string", default: "120" },
		help: { type: "boolean" },
	},
});
if (values.help) {
	console.log(
		"Pi speculative benchmark\nRun from repo root with bash scripts/speculate.sh\nOptions: --dataset PATH --tasks wordy,forth --repeats 2 --latencies 0,2000 --mode both|baseline|speculative --provider openrouter|cerebras|openai --model ID --reasoning low|medium|high --routing cerebras --mismatch-policy cancel|drain --output PATH --max-turns 16 --timeout-seconds 120\nUses OPENROUTER_API_KEY, CEREBRAS_API_KEY, or OPENAI_API_KEY. macOS sandbox-exec and Python 3 are required. Outputs include public task source and model transcripts, but no credentials.",
	);
	process.exit(0);
}
if (!["openrouter", "cerebras", "openai"].includes(values.provider)) throw new Error("Invalid provider");
if (!["low", "medium", "high"].includes(values.reasoning)) throw new Error("Invalid reasoning effort");
if (!["api-key", "chatgpt"].includes(values.auth)) throw new Error("Invalid auth mode");
if (values.auth === "chatgpt" && values.provider !== "openai") throw new Error("ChatGPT auth requires openai");
if (values.auth === "api-key" && !process.env[`${values.provider.toUpperCase()}_API_KEY`])
	throw new Error(`Missing ${values.provider.toUpperCase()}_API_KEY`);
if (!["both", "baseline", "speculative"].includes(values.mode)) throw new Error("Invalid mode");
if (!["cancel", "drain"].includes(values["mismatch-policy"])) throw new Error("Invalid mismatch policy");
const repeats = Number(values.repeats);
const latencies = values.latencies.split(",").map(Number);
if (
	!Number.isInteger(repeats) ||
	repeats < 1 ||
	repeats > 20 ||
	latencies.some((n) => !Number.isFinite(n) || n < 0 || n > 10000)
)
	throw new Error("Invalid repeats or latencies");
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const settings: Settings = {
	provider: values.provider as Settings["provider"],
	model: values.model,
	reasoning: values.reasoning as Settings["reasoning"],
	routing: values.provider === "openrouter" ? values.routing : "",
	latencyMs: 0,
	speculative: false,
	mismatchPolicy: values["mismatch-policy"] as "cancel" | "drain",
	maxTurns: Number(values["max-turns"]),
	timeoutMs: Number(values["timeout-seconds"]) * 1000,
};
let backend: StreamFn | undefined;
if (values.auth === "chatgpt") {
	const { models, credentials } = subscriptionModels();
	if ((await credentials.read("openai"))?.type !== "oauth")
		throw new Error("Connect your ChatGPT plan first: bash scripts/speculate.sh login");
	const resolved = await models.getAuth("openai");
	if (!resolved?.auth.apiKey) throw new Error("ChatGPT authorization unavailable; reconnect");
	const response = await fetch("https://api.openai.com/v1/models", {
		headers: { Authorization: `Bearer ${resolved.auth.apiKey}` },
		signal: AbortSignal.timeout(30000),
	});
	if (!response.ok) throw new Error(`ChatGPT model discovery failed: HTTP ${response.status}`);
	const catalog = (await response.json()) as { models?: { slug: string }[] };
	if (!catalog.models?.some((model) => model.slug === settings.model))
		throw new Error(`Requested model ${settings.model} is not available in this ChatGPT account's catalog`);
	const model = models.getModel("openai", settings.model);
	if (!model) throw new Error(`Model ${settings.model} missing from Pi catalog`);
	console.log(`Using ChatGPT plan: ${settings.model}, ${settings.reasoning} effort`);
	backend = (_selected, context, options) =>
		models.streamSimple(model, context, {
			...options,
			reasoning: settings.reasoning,
			maxTokens: 8192,
			maxRetries: 0,
		});
}
const tasks = values.tasks.split(",");
if (
	!Number.isInteger(settings.maxTurns) ||
	settings.maxTurns < 1 ||
	settings.maxTurns > 100 ||
	!Number.isFinite(settings.timeoutMs) ||
	settings.timeoutMs < 1000 ||
	settings.timeoutMs > 600000
)
	throw new Error("Invalid limits");
const loadedTasks = await Promise.all(tasks.map((name) => loadTask(values.dataset, name)));
const probe = await grade(loadedTasks[0], loadedTasks[0].files[loadedTasks[0].solution]);
if (probe.testsRun < 1) throw new Error(`Grader preflight failed: ${probe.output}`);
const sourceHashes: Record<string, string> = {};
for (const file of [
	"packages/agent/src/speculation.ts",
	"packages/agent/examples/speculative/runner.ts",
	"packages/agent/examples/speculative/cli.ts",
]) {
	sourceHashes[file] = createHash("sha256")
		.update(await readFile(file))
		.digest("hex");
}
const gitRevision = (cwd: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
await writeFile(
	join(output, "protocol.json"),
	JSON.stringify(
		{
			settings,
			auth: values.auth,
			sourceHashes,
			taskHashes: Object.fromEntries(
				loadedTasks.map((task) => [task.name, createHash("sha256").update(JSON.stringify(task)).digest("hex")]),
			),
			tasks,
			repeats,
			latencies,
			datasetRevision: gitRevision(values.dataset),
			piRevision: gitRevision(process.cwd()),
			startedAt: new Date().toISOString(),
			design:
				"Paired, order-alternating, sequential runs; fresh task workspace and original tests; latency is injected only after real test execution in both arms; final grading outside timed region. Public tests, not held out. No provider fallback.",
		},
		null,
		2,
	),
);
const rows: (RunResult & { repetition: number })[] = [];
runs: for (const latencyMs of latencies) {
	for (let repetition = 0; repetition < repeats; repetition++) {
		for (const [taskIndex, name] of tasks.entries()) {
			const task = loadedTasks[taskIndex];
			const order = (taskIndex + repetition) % 2 === 0 ? [false, true] : [true, false];
			for (const speculative of order) {
				if ((values.mode === "baseline" && speculative) || (values.mode === "speculative" && !speculative))
					continue;
				const id = `${latencyMs}ms-r${repetition + 1}-${name}-${speculative ? "speculative" : "baseline"}`;
				console.log(`START ${id}`);
				const result = await runTask(task, { ...settings, latencyMs, speculative }, join(output, id), backend);
				rows.push({ ...result, repetition });
				console.log(
					`DONE ${id}: ${result.passed ? "PASS" : "FAIL"} ${(result.wallMs / 1000).toFixed(2)}s; ${result.requests.length} requests; ${result.speculations.filter((s) => s.status === "accepted").length} hits${result.error ? `; ERROR ${result.error}` : ""}`,
				);
				await writeFile(join(output, "results.json"), JSON.stringify(rows, null, 2));
				if (result.error) {
					console.error(
						"Stopping the cohort after an infrastructure error; incomplete comparisons are not speedup evidence.",
					);
					break runs;
				}
			}
		}
	}
}
const summary = latencies.map((latencyMs) => {
	const cohort = rows.filter((r) => r.latencyMs === latencyMs);
	const arms = [false, true].map((speculative) => {
		const group = cohort.filter((r) => r.speculative === speculative);
		return {
			mode: speculative ? "speculative" : "baseline",
			count: group.length,
			passed: group.filter((r) => r.passed).length,
			errors: group.filter((r) => r.error).length,
			meanMs: group.reduce((n, r) => n + r.wallMs, 0) / group.length,
			requests: group.reduce((n, r) => n + r.requests.length, 0),
			inputTokens: group.flatMap((r) => r.requests).reduce((n, r) => n + r.input, 0),
			outputTokens: group.flatMap((r) => r.requests).reduce((n, r) => n + r.output, 0),
			hits: group.flatMap((r) => r.speculations).filter((s) => s.status === "accepted").length,
			misses: group.flatMap((r) => r.speculations).filter((s) => s.status !== "accepted").length,
		};
	});
	const pairs = cohort
		.filter((r) => !r.speculative)
		.flatMap((base) => {
			const spec = cohort.find((r) => r.speculative && r.task === base.task && r.repetition === base.repetition);
			return spec
				? [
						{
							task: base.task,
							repetition: base.repetition,
							valid: !base.error && !spec.error,
							baselinePassed: base.passed,
							speculativePassed: spec.passed,
							savedMs: base.wallMs - spec.wallMs,
							speedup: base.wallMs / spec.wallMs,
						},
					]
				: [];
		});
	return {
		latencyMs,
		arms,
		pairs,
		observedRegressions: pairs.filter((p) => p.valid && p.baselinePassed && !p.speculativePassed).length,
		observedImprovements: pairs.filter((p) => p.valid && !p.baselinePassed && p.speculativePassed).length,
		speedupRatioOfMeans:
			arms.every((arm) => arm.errors === 0) && pairs.length === tasks.length * repeats
				? arms[0].meanMs / arms[1].meanMs
				: null,
		limitations:
			"Small public-exercise sample. No statistical non-inferiority claim. Native and injected-latency results must be reported separately. Cancelled provider calls may omit billable token usage.",
	};
});
await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`Artifacts: ${output}`);
