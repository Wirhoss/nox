import * as dotenv from "dotenv";
dotenv.config({ quiet: true });

import { Agent } from "./src/agent";
import { Config } from "./src/config";
import logger from "./src/logger";
import { ProviderManager, type ChatProvider } from "./src/provider";
import { ToolRouter } from "./src/tools";
import { sampleTools } from "./src/tools/mocked";

async function main(): Promise<void> {
  logger.info("Starting nox...");
  await Config.init();
  await ProviderManager.instance.init(Config.get("providers"));

  const provider = ProviderManager.instance.getProvider("llama") as ChatProvider;
  const model = provider?.getModel("gemma4-26b");
  if (!provider || !model) {
    throw new Error("Provider or model not found");
  }

  const toolRouter = new ToolRouter(sampleTools);

  const agent = new Agent("Eres un asistente", [], Object.values(toolRouter.tools), {maxIterations: 5, provider, model});
  void (async () => {
    for await (const ev of agent.streamEvents()) {
      if (ev.type === "assistantTextFragment") process.stdout.write(ev.text);
      else if (ev.type === "toolCall") console.log(`\n[tool: ${ev.toolCall.name}]`);
    }
  })();
  await agent.run({ role: "user", content: [{ type: "text", text: "List the files in /tmp, then read the first one you find." }] });
}

process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "Unhandled promise rejection");
  process.exit(1);
});
process.on("uncaughtException", (error) => {
  logger.fatal({ error }, "Uncaught exception");
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "Shutting down");
    process.exit(0);
  });
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    logger.error({ stack: (error as Error).stack }, "Failed to start nox");
    process.exitCode = 1;
  }
}