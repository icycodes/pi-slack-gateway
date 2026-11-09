#!/usr/bin/env node
/**
 * Drive one BindingSession from the terminal instead of Slack (for local testing).
 *
 *   node scripts/console.ts [cwd]
 *
 * Lines are sent like Slack messages (so `!status`, `!stop`, … work). Dialog
 * buttons are answered with `#<n>` (e.g. `#0` picks the first option).
 * Uses the real `pi` with --no-session unless PSG_CONSOLE_KEEP_SESSION=1.
 */
import { createInterface } from "node:readline";
import { parseConfig } from "../src/config.ts";
import { createLogger } from "../src/log.ts";
import { BindingSession, type ChatSink, type DialogButton } from "../src/session.ts";

const cwd = process.argv[2] ?? process.cwd();
const config = parseConfig({
  allowedUsers: ["UCONSOLE"],
  pi: { args: process.env.PSG_CONSOLE_KEEP_SESSION ? [] : ["--no-session"] },
  statusDelayMs: 2_000,
  statusIntervalMs: 3_000,
  notify: "all",
});

let n = 0;
let lastButtons: DialogButton[] = [];
const say = (tag: string, text: string): void => {
  process.stdout.write(`\n[${tag}] ${text}\n`);
};
const sink: ChatSink = {
  postMarkdown: async (md) => (say("reply", md), `c.${++n}`),
  postNotice: async (t) => (say("notice", t), `c.${++n}`),
  postButtons: async (t, buttons) => {
    lastButtons = buttons;
    say("dialog", `${t}\n${buttons.map((b, i) => `  #${i} ${b.label}`).join("\n")}`);
    return `c.${++n}`;
  },
  update: async (ts, t) => say(`update ${ts}`, t),
  remove: async (ts) => say("remove", ts),
  react: async (ts, e) => say("react", `${ts} :${e}:`),
  unreact: async (ts, e) => say("unreact", `${ts} :${e}:`),
};

const session = new BindingSession({
  key: "console",
  label: "console",
  binding: { cwd },
  config,
  sink,
  onSessionFile: (f) => say("session", f ?? "(none)"),
  env: process.env,
  log: createLogger({ console: true }),
});

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const pick = /^#(\d+)$/.exec(line.trim());
  if (pick) {
    const button = lastButtons[Number(pick[1])];
    if (button) {
      const v = JSON.parse(button.value) as { r: string; i: number };
      say("action", String(session.handleDialogAction(v.r, v.i)));
    }
    return;
  }
  void session.handleMessage({ userId: "UCONSOLE", text: line, ts: `u.${++n}` });
});
rl.on("close", () => {
  void session.stop().then(() => process.exit(0));
});
