# Initial speculative inference results

These are the initial Cerebras measurements. See the later [GPT-6 Sol / medium / ChatGPT subscription experiment](GPT-6-SOL-RESULTS.md) for the requested model follow-up.

The prototype works, but these experiments do not establish a reliable end-to-end speedup without accuracy regression. Keep it opt-in. Complete the broader live comparison with sufficient provider credit before making that claim.

## Live task pairs

All requests used `openai/gpt-oss-120b` through OpenRouter with routing restricted to Cerebras and provider fallback disabled. Temperature was zero, reasoning was low, and the maximum output was 8192 tokens. These exploratory runs used immediate cancellation on prediction misses.

| Existing Aider task | Baseline | Speculative | Change in time | Original tests |
| --- | --- | --- | --- | --- |
| Wordy, initial valid pilot | 5.038s | 6.423s | 27.5% slower | Both passed |
| Grade school | 2.428s | 1.781s | 26.7% faster | Both passed |
| Phone number | 2.356s | 1.845s | 21.7% faster | Both passed |

Each row is one pair. Wordy used Bun during early setup; the other two used the final Node launch path. They also differ in cache state and execution history. Do not pool them into a headline speedup or accuracy estimate.

The grade-school and phone-number speculative requests began about 84ms and 76ms early, respectively. Their observed wall-time differences were 648ms and 511ms. The difference exceeds the directly overlapped work, so cache behavior and service/runtime variability plausibly explain part of it. Passing three task pairs is not proof that accuracy is preserved on a larger population.

## Controlled recorded-trajectory replay

Replay reused the successful Wordy baseline's model decisions and timings, while executing real tests. Each condition has three paired repetitions of the same trajectory.

| Added delay per test tool | Baseline mean | Speculative mean | Reduction | Passing runs |
| --- | --- | --- | --- | --- |
| None | 4.967s | 4.909s | 1.17% | 6/6 |
| 2000ms | 11.045s | 10.672s | 3.38% | 6/6 |

Each replay attempted three success predictions, rejected two, and accepted the final one. Only the final assistant turn was hidden. Unrecorded counterfactual branches used a dummy discarded output and the median recorded inference delay. These results support the scheduler's behavior and modest overlap benefit on this trace. They are not independent live accuracy measurements, and the injected delay is not native tool performance.

## Failed and incomplete attempts

- The first pilot had a grader startup defect: Python aborted before executing tests. Its results are invalid and retained separately as `pilot`.
- The delayed live Wordy pilot was interrupted by OpenRouter HTTP 402 `in_flight_budget_exhausted`.
- After the provider's cooldown, the two additional live pairs above completed.
- The planned 48-run comparison covered six tasks, two repetitions, and two latency conditions. It stopped during the first pair after another HTTP 402. In that attempt, the baseline Wordy solution also failed one original test; that failure must not be hidden by citing only the earlier successful pilot.
- A subsequent comparison using the new drain policy failed on its first ordinary baseline request after a cooldown. No live evidence for the drain policy was obtained. It is covered by deterministic tests only.

The account reported zero purchased credits. The provider eventually rejected a non-speculative request too, so the later failures cannot be attributed solely to speculative cancellation. Cancelled requests may retain in-flight credit reservations, but that mechanism was not independently proven here.

The current runner stops at the first infrastructure error and withholds aggregate speedup for incomplete or errored cohorts. Older pilot summaries predate that safeguard; their raw ratios must not be used as evidence.

## Reproduce and extend

See [the setup and usage guide](../../SPECULATION.md). The sanitized [run summary](2026-10-07-summary.json) records all exploratory cohorts, including failures. Full transcripts, generated solutions, request timings, and original-test grades remain in the local ignored `.artifacts/speculation/` directories. No API keys are included.

With sufficient credit or a direct Cerebras key, run:

```sh
bash scripts/speculate.sh --repeats 2 --latencies 0,2000 \
  --mismatch-policy drain --output .artifacts/speculation/drain-funded
python3 scripts/report-speculation.py .artifacts/speculation/drain-funded
```

Repeat separately with `--mismatch-policy cancel`. Increase task coverage and repetitions only after checking provider errors, cache usage, miss rate, and token overhead. For larger gains, the next experiment should evaluate safely starting downstream read-only tools earlier; this prototype intentionally speculates only one model turn.
