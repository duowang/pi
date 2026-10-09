# GPT-6 Sol, medium effort, ChatGPT subscription

The ChatGPT subscription connection works. Pi completed real coding tasks with `gpt-6-sol` at medium effort through the Responses API, using its supported Sign in with ChatGPT flow. No API key or model fallback was used.

The completed natural-latency experiment observed no test regressions, but does not establish a reliable speedup. Delayed-tool experiments were interrupted twice by server-overload errors.

## Completed natural-latency comparison

Six Aider polyglot Python exercises (wordy, grade-school, phone-number, transpose, forth, bowling), two paired repetitions each, alternating arm order:

| Metric | Baseline | Speculative |
| --- | --- | --- |
| Passing tasks | 12/12 | 12/12 |
| Mean task time | 28.978s | 26.737s |
| Model requests | 78 | 78 |
| Infrastructure errors | 0 | 0 |

The observed mean reduction was 7.73%. The exploratory 95% task-cluster bootstrap interval was **−2.73% to +15.01%**, including a slowdown. Only six independent tasks are represented, so this interval is itself unstable.

Twelve of fourteen predictions were accepted. Accepted branches overlapped about **0.820 seconds total**, or **68 milliseconds per task**, while the observed task-time difference was about 26.9 seconds total. The small directly overlapped time cannot explain most of the observed difference. Different generated solutions, correction steps, cache behavior, and service variability matter. For example, the first bowling baseline used eight model requests versus six in the speculative arm.

This prototype's opportunity on these fast local tools is small. Faster wall time in this sample should not be read as a demonstrated 7.73% causal improvement from speculation.

## Delayed-tool comparisons

Both arms add 2000ms after each real test call. These runs examine sensitivity to remote-tool latency; they do not measure native local-tool performance.

- The initial delayed cohort completed five valid pairs, all passing in both arms. A server-overload error then interrupted the bowling baseline. The paired speculative solution passed, but this incomplete pair is excluded from speed comparisons.
- A fresh delayed cohort was started once, preserving the original results. It completed seven valid pairs, all passing in both arms, before another server-overload error interrupted the second grade-school speculative run. That error occurred before any recorded prediction in the affected run.
- The retry's seven valid pairs averaged 36.205s baseline and 32.448s speculative. This descriptive 10.38% reduction is **not a completed-cohort result**. Its exploratory interval was −1.35% to +22.95%. Seven accepted predictions overlapped about 14.85 seconds total, showing that longer tool waits do provide substantially more overlap.
- No further live retries were attempted. Neither overload is counted as a model-accuracy failure or as evidence of a speedup.

Across the smoke test and both cohorts, 54 runs were attempted: 52 completed without infrastructure errors and all 52 passed their original tests; two were interrupted by server overload. These are repeated public-test exercises, not 52 independent hidden-test evaluations. They do not prove accuracy non-inferiority on broader coding work.

## Evidence and reproduction

The [sanitized measurements](2026-10-07-gpt-6-sol-medium.json) retain all three cohorts, including the interrupted runs. Local full transcripts, generated code, and grades are under `.artifacts/speculation/gpt-6-sol-medium-chatgpt-*`. The first smoke pair also verifies actual reuse: `status: accepted`, a 49.94ms head start, and 3055ms generation duration.

Run from the repository root after connecting your ChatGPT plan:

```sh
bash scripts/speculate.sh login
bash scripts/speculate.sh --provider openai --auth chatgpt \
  --model gpt-6-sol --reasoning medium --repeats 2 --latencies 0,2000 \
  --mismatch-policy cancel --timeout-seconds 300 \
  --output .artifacts/speculation/gpt-6-sol-medium-new
```

See [setup and architecture](../../SPECULATION.md). Repository checks and all 64 focused tests passed, including a mocked integration test verifying the exact model, medium effort, Responses API, and accepted speculative reuse. Browser consent and completed live inference separately confirmed subscription access.
