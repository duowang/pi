import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	normalizeContext,
	type SimpleStreamOptions,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { BeforeToolCallContext, StreamFn } from "./types.ts";

export interface SpeculationRecord {
	toolCallId: string;
	status: "accepted" | "mismatch" | "cancelled" | "error";
	/** Time between launching the branch and requesting its result. Not a measured speedup. */
	headStartMs: number;
	generationMs?: number;
	usage?: AssistantMessage["usage"];
}

export interface SpeculationOptions {
	enabled: boolean;
	/** A pure, synchronous predictor. Return undefined to abstain. */
	predict: (call: BeforeToolCallContext) => Pick<ToolResultMessage, "content" | "isError"> | undefined;
	/** Bound speculative work even if a provider never completes. Default 60 seconds. */
	timeoutMs?: number;
	maxBranches?: number;
	/** Drain avoids overlapping fallback with provider-side reservations left by cancellation. */
	mismatchPolicy?: "cancel" | "drain";
	onRecord?: (record: SpeculationRecord) => void;
}

type Request = { model: Parameters<StreamFn>[0]; context: TranscriptContext; options: SimpleStreamOptions };
type Branch = {
	key: string;
	toolCallId: string;
	controller: AbortController;
	started: number;
	result: Promise<AssistantMessage | undefined>;
	status?: SpeculationRecord["status"];
	headStartMs: number;
};

/**
 * Strip runtime-only tool metadata from BOTH speculative and ordinary requests.
 * The committed transcript is untouched. Comparing the complete resulting request
 * (not a semantic result predicate) is the acceptance gate.
 */
function canonicalContext(context: { messages: Message[] }): TranscriptContext {
	return normalizeContext({
		messages: context.messages.map((message): Message => {
			if (message.role !== "toolResult") return structuredClone(message);
			const { details: _details, durationMs: _duration, usage: _usage, ...rest } = message;
			return structuredClone({ ...rest, timestamp: 0 });
		}),
	});
}

/**
 * One-step tool-result speculation using Pi's existing stream and tool hooks.
 * Own one instance per agent. Always call dispose() at run end. Only model
 * inference is speculative; this object never executes a tool or publishes text.
 * Provider callbacks are excluded because they may publish unverified output.
 */
export class SpeculativeStream {
	private last?: Request;
	private branch?: Branch;
	private launched = 0;
	private unhealthy = false;
	private readonly functions = new WeakMap<object, number>();
	private nextFunction = 0;
	private readonly delegate: StreamFn;
	private readonly config: SpeculationOptions;

	constructor(delegate: StreamFn, config: SpeculationOptions) {
		this.delegate = delegate;
		this.config = config;
	}

	private key(request: Request): string {
		const { signal: _signal, ...options } = request.options;
		return JSON.stringify({ ...request, options }, (_name, value: unknown) => {
			if (typeof value === "function") {
				if (!this.functions.has(value)) this.functions.set(value, ++this.nextFunction);
				return { functionIdentity: this.functions.get(value) };
			}
			if (value && typeof value === "object" && !Array.isArray(value)) {
				return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
			}
			return value;
		});
	}

	readonly stream: StreamFn = async (model, context, options = {}) => {
		const request = { model, context: canonicalContext(context), options };
		this.last = request;
		const branch = this.branch;
		if (branch) {
			branch.headStartMs = performance.now() - branch.started;
			if (!options.signal?.aborted && branch.key === this.key(request)) {
				const result = await branch.result;
				if (this.branch === branch) this.branch = undefined;
				if (result && !options.signal?.aborted && !branch.controller.signal.aborted) {
					branch.status = "accepted";
					this.record(branch, result);
					const replay = createAssistantMessageEventStream();
					// Only successful, complete responses are eligible for reuse.
					const reason = result.stopReason === "toolUse" ? "toolUse" : "stop";
					replay.push({ type: "done", reason, message: result });
					return replay;
				}
				if (!branch.status) {
					branch.status = "error";
					this.record(branch, result);
				}
			} else {
				if (this.config.mismatchPolicy === "drain" && !options.signal?.aborted) {
					branch.status = "mismatch";
					const result = await branch.result;
					if (branch.status === "mismatch") this.record(branch, result);
				} else {
					this.cancel(branch, options.signal?.aborted ? "cancelled" : "mismatch");
				}
				if (this.branch === branch) this.branch = undefined;
			}
		}
		return this.delegate(model, request.context, options);
	};

	readonly beforeToolCall = async (call: BeforeToolCallContext, signal?: AbortSignal): Promise<undefined> => {
		const request = this.last;
		if (
			!this.config.enabled ||
			this.unhealthy ||
			!request ||
			this.branch ||
			signal?.aborted ||
			this.launched >= (this.config.maxBranches ?? 32) ||
			call.assistantMessage.stopReason !== "toolUse" ||
			call.assistantMessage.content.filter((block) => block.type === "toolCall").length !== 1 ||
			request.options.onPayload ||
			request.options.onResponse ||
			request.options.onProviderStreamEvent
		)
			return undefined;
		try {
			const prediction = this.config.predict(call);
			if (!prediction) return undefined;
			const context = canonicalContext({
				messages: [
					...request.context.messages,
					call.assistantMessage,
					{
						role: "toolResult",
						toolCallId: call.toolCall.id,
						toolName: call.toolCall.name,
						...prediction,
						timestamp: 0,
					},
				],
			});
			const controller = new AbortController();
			const branch: Branch = {
				key: this.key({ ...request, context }),
				toolCallId: call.toolCall.id,
				controller,
				started: performance.now(),
				headStartMs: 0,
				result: Promise.resolve(undefined),
			};
			this.branch = branch;
			this.launched++;
			branch.result = this.generate(branch, { ...request, context }, signal);
		} catch {
			// A broken predictor must not prevent the real tool from running.
		}
		return undefined;
	};

	private async generate(
		branch: Branch,
		request: Request,
		signal?: AbortSignal,
	): Promise<AssistantMessage | undefined> {
		const abort = () => branch.controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		let resolveAbort: (value: undefined) => void = () => {};
		const aborted = new Promise<undefined>((resolve) => {
			resolveAbort = resolve;
		});
		const onAbort = () => resolveAbort(undefined);
		branch.controller.signal.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(abort, this.config.timeoutMs ?? 60_000);
		try {
			const generate = async () => {
				const stream = await this.delegate(request.model, request.context, {
					...request.options,
					signal: branch.controller.signal,
				});
				// Drain events privately so deltas cannot accumulate or reach the agent.
				for await (const _event of stream) {
					/* no speculative UI events */
				}
				const result = await stream.result();
				// A provider failure is a circuit breaker for the remainder of this run.
				if (result.stopReason === "error") this.unhealthy = true;
				return result.stopReason === "stop" || result.stopReason === "toolUse" ? result : undefined;
			};
			return await Promise.race([
				generate().catch(() => {
					if (!branch.controller.signal.aborted) this.unhealthy = true;
					return undefined;
				}),
				aborted,
			]);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			branch.controller.signal.removeEventListener("abort", onAbort);
		}
	}

	private record(branch: Branch, result?: AssistantMessage): void {
		try {
			this.config.onRecord?.({
				toolCallId: branch.toolCallId,
				status: branch.status ?? "error",
				headStartMs: branch.headStartMs,
				generationMs: result?.durationMs,
				usage: result?.usage,
			});
		} catch {
			/* observational telemetry cannot break the agent */
		}
	}

	private cancel(branch: Branch, status: SpeculationRecord["status"]): void {
		branch.status = status;
		branch.controller.abort();
		void branch.result.then((result) => this.record(branch, result));
	}

	/** Call on external invalidation (for example a workspace revision change). */
	dispose(): void {
		if (this.branch) this.cancel(this.branch, "cancelled");
		this.branch = undefined;
		this.last = undefined;
	}
}
