import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { type SpeculationRecord, SpeculativeStream } from "../src/speculation.ts";
import type { AgentTool, StreamFn } from "../src/types.ts";

const model: Model<"openai-completions"> = {
	id: "test",
	name: "test",
	api: "openai-completions",
	provider: "test",
	baseUrl: "http://invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 10000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function message(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		stopReason,
		usage,
		model: model.id,
		provider: model.provider,
		api: model.api,
		timestamp: 1,
	};
}
function respond(result: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	if (result.stopReason === "error" || result.stopReason === "aborted") {
		stream.push({ type: "error", reason: result.stopReason, error: result });
	} else stream.push({ type: "done", reason: result.stopReason === "toolUse" ? "toolUse" : "stop", message: result });
	return stream;
}
function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

async function scenario(
	options: {
		enabled?: boolean;
		actual?: string;
		predicted?: string;
		error?: boolean;
		multi?: boolean;
		steer?: boolean;
		changeModel?: boolean;
		providerError?: boolean;
		providerLength?: boolean;
		providerThrow?: boolean;
		callback?: boolean;
		block?: boolean;
		abort?: boolean;
		branchBudget?: number;
		mismatchPolicy?: "cancel" | "drain";
		failPredictor?: boolean;
		terminate?: boolean;
	} = {},
) {
	const records: SpeculationRecord[] = [];
	let requests = 0;
	let executed = 0;
	let actualReturned = false;
	let premature = false;
	const delegate: StreamFn = (_model, context) => {
		requests++;
		if (requests === 1)
			return respond(
				message(
					[
						{ type: "toolCall", id: "test-1", name: "check", arguments: {} },
						...(options.multi ? [{ type: "toolCall" as const, id: "test-2", name: "check", arguments: {} }] : []),
					],
					"toolUse",
				),
			);
		if (options.providerError && requests === 2) return respond(message([], "error"));
		if (options.providerLength && requests === 2) return respond(message([], "length"));
		if (options.providerThrow && requests === 2) throw new Error("provider crashed");
		const last = context.messages.at(-1);
		const text = last?.role === "toolResult" ? JSON.stringify(last.content) : "steered";
		return respond(message([{ type: "text", text }]));
	};
	const speculation = new SpeculativeStream(delegate, {
		enabled: options.enabled ?? true,
		maxBranches: options.branchBudget,
		mismatchPolicy: options.mismatchPolicy,
		predict: () => {
			if (options.failPredictor) throw new Error("predictor failed");
			return { content: [{ type: "text", text: options.predicted ?? "passed" }], isError: false };
		},
		onRecord: (record) => records.push(record),
	});
	const tool: AgentTool = {
		name: "check",
		label: "check",
		description: "test",
		parameters: Type.Object({}),
		execute: async () => {
			executed++;
			if (options.abort) agent.abort();
			if (options.steer) agent.steer({ role: "user", content: "Change of plan", timestamp: 2 });
			actualReturned = true;
			return {
				content: [{ type: "text", text: options.actual ?? "passed" }],
				details: { log: "real" },
				isError: options.error,
				terminate: options.terminate,
			};
		},
	};
	const agent = new Agent({
		initialState: { model, tools: [tool] },
		streamFn: speculation.stream,
		onPayload: options.callback ? () => undefined : undefined,
		beforeToolCall: options.block ? async () => ({ block: true, reason: "Denied" }) : speculation.beforeToolCall,
		prepareNextTurn: options.changeModel ? () => ({ model: { ...model, id: "changed" } }) : undefined,
	});
	agent.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant" && requests > 1 && !actualReturned)
			premature = true;
	});
	await agent.prompt("Check");
	speculation.dispose();
	await Promise.resolve();
	return { records, requests, executed, premature, messages: agent.state.messages };
}

describe("tool result speculation", () => {
	it("drain policy waits for a rejected draft before starting fallback", async () => {
		const release = deferred();
		const toolDone = deferred();
		let requests = 0;
		const speculation = new SpeculativeStream(
			() => {
				requests++;
				if (requests === 1)
					return respond(message([{ type: "toolCall", id: "a", name: "check", arguments: {} }], "toolUse"));
				if (requests === 2) {
					const stream = createAssistantMessageEventStream();
					void release.promise.then(() =>
						stream.push({ type: "done", reason: "stop", message: message([{ type: "text", text: "guessed" }]) }),
					);
					return stream;
				}
				return respond(message([{ type: "text", text: "actual" }]));
			},
			{ enabled: true, mismatchPolicy: "drain", predict: () => ({ content: [], isError: false }) },
		);
		const agent = new Agent({
			initialState: {
				model,
				tools: [
					{
						name: "check",
						label: "check",
						description: "check",
						parameters: Type.Object({}),
						execute: async () => {
							toolDone.resolve();
							return { content: [{ type: "text", text: "failed" }], details: {}, isError: true };
						},
					},
				],
			},
			streamFn: speculation.stream,
			beforeToolCall: speculation.beforeToolCall,
		});
		const running = agent.prompt("check");
		await toolDone.promise;
		expect(requests).toBe(2);
		release.resolve();
		await running;
		expect(requests).toBe(3);
		expect(JSON.stringify(agent.state.messages)).not.toContain('"guessed"');
		speculation.dispose();
	});
	it("can drain a wrong draft before fallback without reusing it", async () => {
		const result = await scenario({ actual: "failed", mismatchPolicy: "drain" });
		expect(result.requests).toBe(3);
		expect(result.records[0]?.status).toBe("mismatch");
		expect(JSON.stringify(result.messages.at(-1))).toContain("failed");
	});
	it("does not reuse truncated generation", async () => {
		const result = await scenario({ providerLength: true });
		expect(result.requests).toBe(3);
		expect(result.records[0]?.status).toBe("error");
	});
	it("recovers from a throwing speculative stream provider", async () => {
		const result = await scenario({ providerThrow: true });
		expect(result.requests).toBe(3);
		expect(result.records[0]?.status).toBe("error");
	});
	it("abstains when provider callbacks could expose speculative work", async () => {
		const result = await scenario({ callback: true });
		expect(result.requests).toBe(2);
		expect(result.records).toHaveLength(0);
	});
	it("respects blocked tools without speculating", async () => {
		const result = await scenario({ block: true });
		expect(result.executed).toBe(0);
		expect(result.records).toHaveLength(0);
	});
	it("does not accept a completed prediction after an abort", async () => {
		const result = await scenario({ abort: true });
		expect(result.records.some((r) => r.status === "accepted")).toBe(false);
	});
	it("respects the speculative request budget", async () => {
		const result = await scenario({ branchBudget: 0 });
		expect(result.requests).toBe(2);
		expect(result.records).toHaveLength(0);
	});
	it("reuses an exact prediction without exposing speculative output", async () => {
		const result = await scenario();
		expect(result.requests).toBe(2);
		expect(result.records[0]?.status).toBe("accepted");
		expect(result.executed).toBe(1);
		expect(result.premature).toBe(false);
		expect(result.messages.find((m) => m.role === "toolResult")).toMatchObject({ details: { log: "real" } });
	});
	it("keeps baseline behavior when disabled", async () => {
		const result = await scenario({ enabled: false });
		expect(result.requests).toBe(2);
		expect(result.records).toHaveLength(0);
	});
	it("discards a wrong result and generates from actual diagnostics", async () => {
		const result = await scenario({ actual: "failed" });
		expect(result.requests).toBe(3);
		expect(result.records[0]?.status).toBe("mismatch");
		expect(JSON.stringify(result.messages.at(-1))).toContain("failed");
	});
	it("does not mistake matching text with an error flag for success", async () => {
		const result = await scenario({ error: true });
		expect(result.requests).toBe(3);
		expect(result.records[0]?.status).toBe("mismatch");
	});
	it("invalidates on steering", async () => {
		const result = await scenario({ steer: true });
		expect(result.requests).toBe(3);
		expect(result.records[0]?.status).toBe("mismatch");
	});
	it("invalidates on model changes", async () => {
		const result = await scenario({ changeModel: true });
		expect(result.requests).toBe(3);
		expect(result.records[0]?.status).toBe("mismatch");
	});
	it("abstains on multi-tool batches", async () => {
		const result = await scenario({ multi: true });
		expect(result.requests).toBe(2);
		expect(result.records).toHaveLength(0);
		expect(result.executed).toBe(2);
	});
	it("falls back after a speculative provider error", async () => {
		const result = await scenario({ providerError: true });
		expect(result.requests).toBe(3);
		expect(result.records[0]?.status).toBe("error");
	});
	it("a predictor exception never blocks the actual tool", async () => {
		const result = await scenario({ failPredictor: true });
		expect(result.requests).toBe(2);
		expect(result.executed).toBe(1);
	});
	it("disposes unused predictions after a terminating tool", async () => {
		const result = await scenario({ terminate: true });
		expect(result.messages.at(-1)?.role).toBe("toolResult");
		expect(result.records[0]?.status).toBe("cancelled");
	});
	it("holds speculative tool calls until the actual tool completes", async () => {
		const gate = deferred();
		const drafted = deferred();
		let writes = 0;
		let requests = 0;
		const speculation = new SpeculativeStream(
			() => {
				requests++;
				if (requests === 1)
					return respond(message([{ type: "toolCall", id: "a", name: "check", arguments: {} }], "toolUse"));
				if (requests === 2) {
					drafted.resolve();
					return respond(message([{ type: "toolCall", id: "b", name: "write", arguments: {} }], "toolUse"));
				}
				return respond(message([{ type: "text", text: "done" }]));
			},
			{
				enabled: true,
				predict: ({ toolCall }) =>
					toolCall.name === "check"
						? {
								content: [{ type: "text", text: "passed" }],
								isError: false,
							}
						: undefined,
			},
		);
		const agent = new Agent({
			initialState: {
				model,
				tools: [
					{
						name: "check",
						label: "check",
						description: "check",
						parameters: Type.Object({}),
						execute: async () => {
							await gate.promise;
							return { content: [{ type: "text", text: "passed" }], details: {} };
						},
					},
					{
						name: "write",
						label: "write",
						description: "write",
						parameters: Type.Object({}),
						execute: async () => {
							writes++;
							return { content: [], details: {} };
						},
					},
				],
			},
			streamFn: speculation.stream,
			beforeToolCall: speculation.beforeToolCall,
		});
		const run = agent.prompt("Do work");
		await drafted.promise;
		expect(writes).toBe(0);
		gate.resolve();
		await run;
		expect(writes).toBe(1);
		speculation.dispose();
	});
	it("times out a stalled speculative provider and falls back", async () => {
		let requests = 0;
		const records: SpeculationRecord[] = [];
		const speculation = new SpeculativeStream(
			() => {
				requests++;
				if (requests === 1)
					return respond(message([{ type: "toolCall", id: "a", name: "check", arguments: {} }], "toolUse"));
				if (requests === 2) return createAssistantMessageEventStream();
				return respond(message([{ type: "text", text: "recovered" }]));
			},
			{
				enabled: true,
				timeoutMs: 5,
				predict: () => ({ content: [], isError: false }),
				onRecord: (r) => records.push(r),
			},
		);
		const agent = new Agent({
			initialState: {
				model,
				tools: [
					{
						name: "check",
						label: "check",
						description: "check",
						parameters: Type.Object({}),
						execute: async () => ({ content: [], details: {} }),
					},
				],
			},
			streamFn: speculation.stream,
			beforeToolCall: speculation.beforeToolCall,
		});
		await agent.prompt("Do work");
		expect(requests).toBe(3);
		expect(records[0]?.status).toBe("error");
		speculation.dispose();
	});
});
