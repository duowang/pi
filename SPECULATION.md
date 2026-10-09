# Speculative inference across tool calls

This fork adds a headless Pi experiment: while a test tool runs, predict that it will pass and generate the next assistant turn. Reuse that turn only when the actual next model request matches the predicted request. Otherwise discard it and run the normal request.

The implementation uses Pi's existing `Agent`, tool hooks, and model stream API. The normal agent loop is unchanged. This is an SDK and benchmark experiment, not a new flag in Pi's interactive TUI. It performs one speculative model call at a time and never executes downstream tools speculatively.

See [initial results and limitations](experiments/speculation/RESULTS.md). The observed live results are mixed, and provider credit limits prevented the planned full comparison.

The later [GPT-6 Sol subscription experiment](experiments/speculation/GPT-6-SOL-RESULTS.md) completed all 24 natural-latency runs. All passed; timing evidence remains inconclusive. Two delayed-tool cohorts were interrupted by server overload.

## Setup

Prerequisites: Node.js 22.19 or later, npm, Git, macOS with `sandbox-exec`, and Python 3 installed in a standard system or Homebrew location. `PYTHON_BIN` can select a different interpreter within those locations.

```sh
git clone https://github.com/duowang/pi.git pi-speculative
cd pi-speculative
bash scripts/setup-speculation.sh
```

Setup installs the lockfile with lifecycle scripts disabled, hydrates Pi's model catalog, and fetches the Aider polyglot benchmark at commit `7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f` into the sibling `pi-benchmark-tasks` directory. The preflight must run the original tests; failing tests on the unimplemented stub are expected. Zero tests is a setup failure.

This experiment was based on Pi commit `1cedd32724abfcb0915f76cc61b6827e2c16dbad`. Running from source uses Pi's own Node source resolver, so no global install, Bun, or compiled package build is needed.

## Run a live comparison

### GPT-6 Sol at medium effort

To use your ChatGPT subscription, connect it through Pi's supported browser sign-in, then run both arms with the exact requested model:

```sh
bash scripts/speculate.sh login
bash scripts/speculate.sh --provider openai --auth chatgpt \
  --model gpt-6-sol --reasoning medium \
  --tasks wordy,grade-school,phone-number --repeats 2 --latencies 0,2000 \
  --mismatch-policy cancel --timeout-seconds 300 \
  --output .artifacts/speculation/gpt-6-sol-medium-chatgpt
```

Approve ChatGPT plan usage in the browser. Both ordinary and speculative calls consume your plan's limits. Credentials and a stable installation ID are stored under `.pi_config/speculation/`, which is ignored by Git and separate from benchmark reports. Never share that directory. The runner checks your account's current model catalog and stops if the requested model is absent. It uses Pi's credential refresh and does not fall back to an API key. Login alone does not prove inference access; a completed benchmark request does.

Alternatively, set `OPENAI_API_KEY` and use the API billing path:

```sh
bash scripts/speculate.sh --provider openai --model gpt-6-sol --reasoning medium \
  --tasks wordy,grade-school,phone-number --repeats 2 --latencies 0,2000 \
  --mismatch-policy cancel --timeout-seconds 300 \
  --output .artifacts/speculation/gpt-6-sol-medium
```

This path uses the Responses API, with the same medium effort in ordinary and speculative requests. Temperature is omitted. [GPT-6 Sol's documented tool support](https://developers.openai.com/api/docs/models/gpt-6-sol) requires Responses when using reasoning. No alternate model or provider fallback is used. The protocol records the requested reasoning effort. Existing Cerebras results remain separate. The initial subscription-backed grade-school pair passed in both modes: 17.79s baseline and 17.67s speculative, with one accepted prediction. This confirms working inference and reuse, not a reliable speedup.

### Cerebras

Set `OPENROUTER_API_KEY` in your shell without putting it in source files. The default model is `openai/gpt-oss-120b`, restricted to the Cerebras provider with fallback disabled.

```sh
# One paired smoke test, without artificial tool delay.
bash scripts/speculate.sh --tasks wordy --repeats 1 --latencies 0

# Six existing tasks, two repetitions, both native and delayed tools: 48 runs.
bash scripts/speculate.sh --repeats 2 --latencies 0,2000

# Enable or disable speculation explicitly.
bash scripts/speculate.sh --tasks wordy --mode speculative --latencies 0 --repeats 1
bash scripts/speculate.sh --tasks wordy --mode baseline --latencies 0 --repeats 1
```

For a direct Cerebras account, set `CEREBRAS_API_KEY` and supply the model ID accepted by that account:

```sh
bash scripts/speculate.sh --provider cerebras --model gpt-oss-120b \
  --tasks wordy --repeats 1 --latencies 0
```

The full comparison is paid inference. Each task is limited to 16 assistant turns and 120 seconds by default. It uses at most one speculative continuation at a time, but an aborted request may retain a provider-side credit reservation. Ensure the account has sufficient credit and concurrency headroom. Provider errors disable further speculation for that run; ordinary provider failures remain explicit errors in the report rather than being hidden as model failures or successful speedups.

The live runner defaults to `--mismatch-policy drain`: finish a rejected speculative request before launching the real fallback. This adds miss latency and reduces overlap between rejected work and fallback requests; its effect on provider credit reservations has not been verified. Use `--mismatch-policy cancel` to test immediate cancellation. `SpeculativeStream` itself defaults to cancellation; the benchmark's provider-specific choice is saved in the protocol. Compare results only within the same policy.

## What the benchmark measures

Tasks are the Python `wordy`, `grade-school`, `phone-number`, `transpose`, `forth`, and `bowling` exercises from [Aider's polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark), originally sourced from Exercism. These are existing code-editing tasks with deterministic tests, not the complete Aider benchmark or SWE-bench. No reference implementation is supplied to the agent. The original tests are visible to it, so this is not a held-out generalization measurement.

Both arms use the same Pi agent, prompt, model, sampling options, tool interface, and turn limit. Each starts with fresh stub files. The order alternates by task and repetition, and runs are sequential to reduce cross-run resource contention. The agent may read task files, edit only the solution file, and invoke `run_tests`. Generated Python executes in a fresh sandbox with a minimal environment and no API keys or network access. Final grading uses a fresh copy of the original tests, outside the timed agent execution.

Passing tests return exactly `{"status":"passed"}` in both arms; detailed logs remain in the real tool's metadata. Failures return actual diagnostic text and an error flag. The predictor is a fixed success guess and reads neither test output nor the reference answer.

The `0` latency condition uses real local tool time. The `2000` condition adds two seconds after every test execution in both arms to simulate remote tool latency. Report them separately. Artificial latency is a sensitivity experiment and must not be presented as native-tool performance.

Each output directory under `.artifacts/speculation/` contains the protocol, source and task hashes, raw results, transcripts, generated solutions, independent final grades, and a summary. Metrics include task pass rate, paired pass-to-fail regressions, wall time, tool times, request counts, tokens, and accepted/rejected speculation. Token counts on aborted requests may be unavailable. Direct-key paths do not configure model cost fields, and subscription runs may inherit nominal API prices from Pi's catalog. These fields are not actual billing records; neither zero values nor catalog estimates establish what was charged.

Generate a readable per-task report with `python3 scripts/report-speculation.py .artifacts/speculation/YOUR_RUN`. The report distinguishes complete, error-free pairs from infrastructure failures. With at least three tasks it includes an exploratory task-cluster bootstrap interval; repeated runs of one task are not treated as independent tasks.

Do not call the feature an improvement unless repeated live runs show lower task latency without a material pass-rate decline. A small sample with no regressions cannot establish statistical non-inferiority. Infrastructure errors invalidate a clean speed comparison; the current summary withholds its aggregate speedup when they occur.

## Replay without API charges

```sh
bash scripts/speculate.sh replay \
  --trace .artifacts/speculation/YOUR_RUN/0ms-r1-wordy-baseline/transcript.json \
  --task wordy --repeats 3 --latencies 0,2000 \
  --output .artifacts/speculation/my-replay
```

Replay returns recorded model decisions with their recorded delays and executes real tests. It checks that the recorded trajectory still produces a passing artifact. Unrecorded counterfactual drafts use the median recorded model latency and must be discarded; replay fails if one reaches the committed transcript. This tests scheduling and integration, not independent model accuracy or live provider latency.

## Integrate with a Pi Agent

```ts
import { Agent, SpeculativeStream } from "@earendil-works/pi-agent-core";

const speculation = new SpeculativeStream(providerStream, {
  enabled: true,
  predict: ({ toolCall }) => toolCall.name === "run_tests"
    ? { content: [{ type: "text", text: '{"status":"passed"}' }], isError: false }
    : undefined,
  onRecord: record => telemetry.push(record),
});

const agent = new Agent({
  initialState: { model, tools, systemPrompt },
  streamFn: speculation.stream,
  beforeToolCall: speculation.beforeToolCall,
});
try {
  await agent.prompt(task);
} finally {
  speculation.dispose();
}
```

Use a separate instance per run. If you already have a permission hook, run it first and call `speculation.beforeToolCall` only when it permits execution. Do not replace an existing permission hook. Call `dispose()` on external invalidation, such as a workspace revision change.

The stream wrapper canonicalizes runtime-only tool metadata in both modes while preserving real logs in the agent transcript. It compares the entire canonical next request, including model and options, before reuse. Context changes, steering, result mismatches, and error flags reject the prediction. Multi-tool batches abstain. Provider callbacks (`onPayload`, `onResponse`, `onProviderStreamEvent`) also cause abstention because they could mutate requests or expose unverified output. Use a stateless provider adapter whose behavior is determined by its arguments. Extra hidden mutable state is outside this prototype's correctness contract.

The accepted response is delivered after verification as a completed message. Speculative token deltas are never shown to the user. Existing Pi tool validation and execution then handle any tool calls in that response normally. No KV-cache editing or inference-server changes are involved.

## Validate changes

```sh
npm run check
cd packages/agent
node ../../node_modules/vitest/dist/cli.js --run \
  test/speculation.test.ts test/speculative-runner.test.ts test/agent-loop.test.ts
```

The grader integration tests require permission to launch the macOS sandbox. They cover real pass/fail grading, empty-test rejection, missing provider credentials, network denial, and write confinement. The speculation tests cover exact reuse, mismatches, error flags, steering, model changes, batching, provider failures, truncation, cancellation, budgets, and suppressing unverified actions.
