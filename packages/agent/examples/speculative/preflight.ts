import { grade, loadTask } from "./runner.ts";

const task = await loadTask(process.argv[2] ?? "../pi-benchmark-tasks", "wordy");
const result = await grade(task, task.files[task.solution]);
console.log(JSON.stringify({ testsRun: result.testsRun, passed: result.passed, code: result.code }, null, 2));
if (result.testsRun < 1) console.error(result.output);
if (result.testsRun < 1) process.exitCode = 1;
