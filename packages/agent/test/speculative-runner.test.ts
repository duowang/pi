import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import * as responses from "../../ai/src/api/openai-responses.ts";
import { grade, runTask, type Task } from "../examples/speculative/runner.ts";

const task: Task = {
	name: "fixture",
	solution: "solution.py",
	test: "solution_test.py",
	prompt: "Return 42",
	files: {
		"solution_test.py":
			"import unittest\nfrom solution import answer\nclass Test(unittest.TestCase):\n def test_answer(self): self.assertEqual(answer(), 42)\n",
	},
};
describe.skipIf(process.platform !== "darwin")("speculative benchmark grader", () => {
	it("uses GPT-6 Sol Responses at medium effort in both arms and speculative requests", async () => {
		const folder = await mkdtemp(join(tmpdir(), "pi-spec-provider-test-"));
		vi.stubEnv("OPENAI_API_KEY", "test-not-a-real-key");
		const stream = vi.spyOn(responses, "streamSimple").mockImplementation((model, context, options) => {
			expect(model.id).toBe("gpt-6-sol");
			expect(model.api).toBe("openai-responses");
			expect(options?.reasoning).toBe("medium");
			expect(options?.temperature).toBeUndefined();
			const finished = context.messages.some((m) => m.role === "toolResult");
			const events = createAssistantMessageEventStream();
			events.push({
				type: "done",
				reason: finished ? "stop" : "toolUse",
				message: {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: finished
						? [{ type: "text", text: "Done" }]
						: [{ type: "toolCall", id: "test-call", name: "run_tests", arguments: {} }],
					stopReason: finished ? "stop" : "toolUse",
					timestamp: 1,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			});
			return events;
		});
		try {
			for (const speculative of [false, true]) {
				const result = await runTask(
					{ ...task, files: { ...task.files, "solution.py": "def answer(): return 42\n" } },
					{
						provider: "openai",
						model: "gpt-6-sol",
						reasoning: "medium",
						routing: "",
						latencyMs: 0,
						maxTurns: 4,
						timeoutMs: 10000,
						speculative,
					},
					join(folder, String(speculative)),
				);
				expect(result.passed).toBe(true);
				expect(result.speculations.filter((s) => s.status === "accepted")).toHaveLength(speculative ? 1 : 0);
				await rm(result.workspace, { recursive: true, force: true });
			}
			expect(stream).toHaveBeenCalledTimes(4);
		} finally {
			stream.mockRestore();
			vi.unstubAllEnvs();
			await rm(folder, { recursive: true, force: true });
		}
	});
	it("grades correct and incorrect code with real original tests", async () => {
		expect(await grade(task, "def answer(): return 42\n")).toMatchObject({ passed: true, testsRun: 1 });
		expect(await grade(task, "def answer(): return 41\n")).toMatchObject({ passed: false, testsRun: 1 });
	});
	it("does not call an early zero exit a pass", async () => {
		expect(await grade(task, "import os\nos._exit(0)\n")).toMatchObject({ passed: false, testsRun: 0 });
	});
	it("keeps provider credentials out of the subprocess environment", async () => {
		expect(
			await grade(
				task,
				"import os\ndef answer():\n assert 'OPENROUTER_API_KEY' not in os.environ\n assert 'CEREBRAS_API_KEY' not in os.environ\n return 42\n",
			),
		).toMatchObject({ passed: true });
	});
	it("denies network access", async () => {
		expect(
			await grade(
				task,
				"import socket\ndef answer():\n try:\n  socket.create_connection(('127.0.0.1', 9))\n except PermissionError:\n  return 42\n return 0\n",
			),
		).toMatchObject({ passed: true });
	});
	it("denies writes outside the grader workspace", async () => {
		expect(
			await grade(
				task,
				"def answer():\n try:\n  open('/private/tmp/pi-speculation-forbidden-write', 'w')\n except PermissionError:\n  return 42\n return 0\n",
			),
		).toMatchObject({ passed: true });
	});
});
