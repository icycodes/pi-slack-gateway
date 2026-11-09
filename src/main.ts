#!/usr/bin/env node
/** Entry point: `node src/main.ts` (Node ≥ 22.18 runs TypeScript directly). */
import { mkdirSync } from "node:fs";
import { defaultConfigPath, loadConfig } from "./config.ts";
import { Gateway } from "./gateway.ts";
import { log } from "./log.ts";
import { SlackPlatform } from "./slack.ts";
import { StateStore } from "./state.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    log.error(`missing environment variable ${name}`);
    process.exit(2);
  }
  return value;
}

/** Environment for pi children: everything except the gateway's own secrets. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SLACK_") || key.startsWith("PI_SLACK_GATEWAY_")) delete env[key];
  }
  return env;
}

async function main(): Promise<void> {
  const botToken = requireEnv("SLACK_BOT_TOKEN");
  const appToken = requireEnv("SLACK_APP_TOKEN");
  const configPath = defaultConfigPath();
  const config = loadConfig(configPath);
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  log.info("starting pi-slack-gateway", {
    config: configPath,
    stateDir: config.stateDir,
    dm: config.dm.cwd,
    channels: Object.keys(config.channels).length,
    pi: config.pi.command,
  });

  const state = new StateStore(config.stateDir, log);
  const slack = new SlackPlatform({ botToken, appToken, log });
  const gateway = new Gateway({ config, state, platform: slack, log, env: childEnv() });

  await slack.start({
    onMessage: (ev) => gateway.handle(ev),
    onDialogAction: (userId, value) => gateway.handleDialogAction(userId, value),
  });
  await gateway.resumeAll();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    await slack.stop().catch((e: Error) => log.warn("slack stop failed", { error: e }));
    await gateway.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e: Error) => {
  log.error("fatal", { error: e });
  process.exit(1);
});
