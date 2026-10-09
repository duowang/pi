import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { type AssistantMessage, createAssistantMessageEventStream, type Message } from "@earendil-works/pi-ai";
import type { StreamFn } from "../../src/types.ts";
import { loadTask, type RunResult, runTask } from "./runner.ts";

const { values } = parseArgs({
	options: {
		trace: { type: "string" },
		dataset: { type: "string", default: "../pi-benchmark-tasks" },
		task: { type: "string", default: "wordy" },
		repeats: { type: "string", default: "3" },
		latencies: { type: "string", default: "0,2000" },
		output: { type: "string", default: ".artifacts/speculation/replay" },
	},
});
if (!values.trace) throw new Error("Pass --trace PATH/to/transcript.json from a successful live baseline.");
const transcript = JSON.parse(await readFile(values.trace, "utf8")) as Message[];
// This normalization is ONLY for recorded-response lookup, never speculation acceptance.
const traceKey = (messages: Message[]) =>
	JSON.stringify(
		messages.map((message) => {
			const data: Record<string, unknown> = { ...message };
			for (const key of ["timestamp", "durationMs", "usage", "details", "thinkingLevel"]) delete data[key];
			return data;
		}),
		(_key, value: unknown) => {
			if (typeof value === "string")
				return value
					.replace(/\/private\/var\/folders\/[^\s"\\]*\/pi-spec-grade-[^/"\\]*/g, "<workspace>")
					.replace(/Ran (\d+) tests? in [\d.]+s/g, "Ran $1 tests");
			if (value && typeof value === "object" && !Array.isArray(value))
				return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
			return value;
		},
	);
const responses = new Map<string, AssistantMessage>();
for (let i = 0; i < transcript.length; i++) {
	const message = transcript[i];
	if (message.role === "assistant") responses.set(traceKey(transcript.slice(0, i)), message);
}
const timings = [...responses.values()].map((m) => m.durationMs ?? 0).sort((a, b) => a - b);
const medianMs = timings[Math.floor(timings.length / 2)];
const counterfactual = "Unrecorded counterfactual draft (replay only)";
const backend: StreamFn = (_model, context, options) => {
	const recorded = responses.get(traceKey(context.messages));
	const template = recorded ?? [...responses.values()].at(-1)!;
	const stream = createAssistantMessageEventStream();
	void (async () => {
		try {
			await sleep(recorded?.durationMs ?? medianMs, undefined, { signal: options?.signal });
			const result = structuredClone(template);
			if (!recorded) {
				result.content = [{ type: "text", text: counterfactual }];
				result.stopReason = "stop";
			}
			stream.push({ type: "done", reason: result.stopReason === "toolUse" ? "toolUse" : "stop", message: result });
		} catch {
			stream.push({
				type: "error",
				reason: "aborted",
				error: { ...structuredClone(template), content: [], stopReason: "aborted" },
			});
		}
	})();
	return stream;
};
const task = await loadTask(values.dataset, values.task);
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const rows: (RunResult & { repetition: number })[] = [];
for (const latencyMs of values.latencies.split(",").map(Number)) {
	for (let repetition = 0; repetition < Number(values.repeats); repetition++) {
		for (const speculative of repetition % 2 ? [true, false] : [false, true]) {
			const id = `${latencyMs}ms-r${repetition + 1}-${speculative ? "speculative" : "baseline"}`;
			const result = await runTask(
				task,
				{
					provider: "openrouter",
					model: "openai/gpt-oss-120b",
					routing: "cerebras",
					latencyMs,
					speculative,
					maxTurns: 32,
					timeoutMs: 120000,
				},
				join(output, id),
				backend,
			);
			const produced = await readFile(join(output, id, "transcript.json"), "utf8");
			if (produced.includes(counterfactual))
				throw new Error("Replay left the recorded trajectory; results are invalid.");
			rows.push({ ...result, repetition });
			console.log(
				`${id}: ${result.passed ? "PASS" : "FAIL"} ${result.wallMs.toFixed(0)}ms, ${result.speculations.filter((s) => s.status === "accepted").length} hits`,
			);
			await writeFile(join(output, "results.json"), JSON.stringify(rows, null, 2));
		}
	}
}
await writeFile(
	join(output, "protocol.json"),
	JSON.stringify(
		{
			kind: "recorded-trajectory replay",
			trace: resolve(values.trace),
			values,
			counterfactualLatencyMs: medianMs,
			limitations:
				"Reuses recorded assistant decisions and timing, executes real tests. Unknown counterfactual branches use a dummy discarded answer and median latency. Validates scheduling and replayed artifact correctness, NOT independent model accuracy or live service speedup.",
		},
		null,
		2,
	),
);
console.log(`Replay results: ${output}`);
