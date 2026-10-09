import { resolve } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "../../../ai/src/providers/openai.ts";
import { AuthStorage } from "../../../coding-agent/src/core/auth-storage.ts";

// Separate from benchmark artifacts; never include this directory in reports.
export const subscriptionDirectory = resolve(".pi_config/speculation");
export function subscriptionModels() {
	const credentials = AuthStorage.create(resolve(subscriptionDirectory, "auth.json"));
	const models = createModels({ credentials });
	models.setProvider(openaiProvider());
	return { models, credentials };
}
