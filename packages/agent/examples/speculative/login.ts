import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { subscriptionDirectory, subscriptionModels } from "./subscription.ts";

await mkdir(subscriptionDirectory, { recursive: true, mode: 0o700 });
const hostPath = resolve(subscriptionDirectory, "host-id");
try {
	await writeFile(hostPath, randomUUID(), { flag: "wx", mode: 0o600 });
} catch (error) {
	if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
}
const hostId = (await readFile(hostPath, "utf8")).trim();
const { models } = subscriptionModels();
const terminal = createInterface({ input: process.stdin, output: process.stdout });
console.log("Continue with ChatGPT: approve plan usage for Pi Speculation Benchmark in your browser.");
console.log("Both ordinary and speculative requests use your ChatGPT plan limits.");
try {
	await models.login(
		"openai",
		"oauth",
		{
			signal: AbortSignal.timeout(10 * 60 * 1000),
			prompt: (prompt) => terminal.question(`${prompt.message}\n`, { signal: prompt.signal }),
			notify: (event) => {
				if (event.type === "auth_url") {
					console.log(`Continue with ChatGPT: ${event.url}`);
					if (process.platform === "darwin") execFile("open", [event.url]);
				} else if (event.type === "info" || event.type === "progress") console.log(event.message);
			},
		},
		{ getDeviceId: () => hostId, agentName: "Pi Speculation Benchmark" },
	);
	console.log("ChatGPT plan connected. Credentials saved privately, outside benchmark reports.");
} finally {
	terminal.close();
}
