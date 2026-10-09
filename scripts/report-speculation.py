"""Summarize paired runs without treating infrastructure failures as speedups."""

import argparse
import json
import random
import statistics
from collections import defaultdict
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("directory", type=Path)
args = parser.parse_args()
root = args.directory
rows = json.loads((root / "results.json").read_text())
protocol = json.loads((root / "protocol.json").read_text())
replay = protocol.get("kind") == "recorded-trajectory replay"
lines = ["# Speculative inference results", "",
         "Recorded-trajectory replay; not independent model-accuracy evidence." if replay
         else "Live paired coding-task evaluation. Small samples do not establish accuracy non-inferiority.", "",
         "| Added test latency | Completed runs | Infrastructure errors | Valid pairs | Baseline passed | Speculative passed | Baseline mean | Speculative mean | Reduction |",
         "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
detail = []
for delay in sorted({r["latencyMs"] for r in rows}):
    cohort = [r for r in rows if r["latencyMs"] == delay]
    groups = defaultdict(dict)
    for row in cohort:
        key = (row["task"], row["repetition"])
        if row["speculative"] in groups[key]:
            raise ValueError(f"Duplicate arm for {key}")
        groups[key][row["speculative"]] = row
    pairs = [(arms[False], arms[True]) for arms in groups.values()
             if set(arms) == {False, True} and not any(r.get("error") for r in arms.values())]
    errors = sum(bool(r.get("error")) for r in cohort)
    baseline = [p[0] for p in pairs]
    speculative = [p[1] for p in pairs]
    base_mean = statistics.mean(r["wallMs"] for r in baseline) if pairs else None
    spec_mean = statistics.mean(r["wallMs"] for r in speculative) if pairs else None
    reduction = 100 * (1 - spec_mean / base_mean) if pairs else None
    fmt = lambda v: "unavailable" if v is None else f"{v / 1000:.3f}s"
    change = "unavailable" if reduction is None else f"{reduction:.2f}%"
    lines.append(f"| {delay}ms | {len(cohort)} | {errors} | {len(pairs)} | "
                 f"{sum(r['passed'] for r in baseline)}/{len(pairs)} | "
                 f"{sum(r['passed'] for r in speculative)}/{len(pairs)} | "
                 f"{fmt(base_mean)} | {fmt(spec_mean)} | {change} |")
    detail.extend(["", f"## Added test latency {delay}ms", "",
                   "Latency means above use only complete pairs without infrastructure errors. A failed solution with a valid test grade remains included.", "",
                   "| Task | Repetition | Baseline tests | Speculative tests | Baseline time | Speculative time |",
                   "| --- | --- | --- | --- | --- | --- |"])
    for base, spec in pairs:
        detail.append(f"| {base['task']} | {base['repetition'] + 1} | {'pass' if base['passed'] else 'fail'} | "
                      f"{'pass' if spec['passed'] else 'fail'} | {fmt(base['wallMs'])} | {fmt(spec['wallMs'])} |")
    regressions = sum(b["passed"] and not s["passed"] for b, s in pairs)
    detail.extend(["", f"Observed pass-to-fail regressions: {regressions}. This is an observed count, not an upper bound on population regression risk."])
    branches = [event for row in speculative for event in row["speculations"]]
    accepted = [event for event in branches if event["status"] == "accepted"]
    overlap = sum(min(e["headStartMs"], e.get("generationMs") or 0) for e in accepted)
    detail.extend(["", f"Accepted predictions: {len(accepted)}/{len(branches)}. Sum of min(head start, generation duration) for accepted branches: {overlap:.1f}ms.",
                   "This is a scheduling-overlap estimate, not a causal attribution of the live wall-time difference. Network, caching, model paths, and provider variability also affect live times."])
    if not replay and len({b["task"] for b, _ in pairs}) >= 3:
        # Resample tasks, not individual repetitions of the same task.
        by_task = defaultdict(list)
        for base, spec in pairs:
            by_task[base["task"]].append((base["wallMs"], spec["wallMs"]))
        clusters = list(by_task.values())
        rng = random.Random(20261007)
        boot = []
        for _ in range(5000):
            sample = [pair for cluster in rng.choices(clusters, k=len(clusters)) for pair in cluster]
            boot.append(100 * (1 - sum(s for b, s in sample) / sum(b for b, s in sample)))
        boot.sort()
        detail.extend(["", f"Exploratory 95% task-cluster bootstrap interval for latency reduction: {boot[125]:.2f}% to {boot[4874]:.2f}%. Few tasks make this interval unstable."])
    if errors:
        detail.extend(["", "Infrastructure errors (excluded from paired speed calculations):"])
        for row in cohort:
            if row.get("error"):
                detail.append(f"- {row['task']} / {'speculative' if row['speculative'] else 'baseline'}: {row['error']}")
lines += detail + ["", "## Protocol", "", "```json", json.dumps(protocol, indent=2), "```", ""]
(root / "report.md").write_text("\n".join(lines))
print(root / "report.md")
