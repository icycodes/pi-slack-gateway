import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseConfig, type GatewayConfig } from "../src/config.ts";
import { createLogger } from "../src/log.ts";
import type { ChatSink, DialogButton, PostOptions } from "../src/session.ts";

export const FAKE_PI = resolve(import.meta.dirname, "fixtures", "fake-pi.ts");
export const quietLog = createLogger({ test: true });

export function tempDir(prefix = "psg-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function testConfig(overrides: Record<string, unknown> = {}): GatewayConfig {
  const stateDir = tempDir();
  return parseConfig({
    allowedUsers: ["U111"],
    allowedRoots: [tmpdir()],
    dm: { cwd: tmpdir() },
    pi: { command: FAKE_PI, appendSystemPrompt: null },
    statusDelayMs: 0,
    statusIntervalMs: 50,
    stateDir,
    ...overrides,
  });
}

export function testEnv(sessionDir = tempDir("psg-sessions-")): NodeJS.ProcessEnv {
  return { ...process.env, FAKE_PI_SESSION_DIR: sessionDir };
}

export type SinkCall =
  | { kind: "markdown"; text: string; threadTs?: string; ts: string }
  | { kind: "notice"; text: string; threadTs?: string; ts: string }
  | { kind: "buttons"; text: string; buttons: DialogButton[]; ts: string }
  | { kind: "update"; ts: string; text: string }
  | { kind: "remove"; ts: string }
  | { kind: "react"; ts: string; emoji: string }
  | { kind: "unreact"; ts: string; emoji: string };

export class FakeSink implements ChatSink {
  calls: SinkCall[] = [];
  private n = 0;

  private nextTs(): string {
    return `100.${String(++this.n).padStart(4, "0")}`;
  }

  async postMarkdown(text: string, opts?: PostOptions) {
    const ts = this.nextTs();
    this.calls.push({ kind: "markdown", text, threadTs: opts?.threadTs, ts });
    return ts;
  }
  async postNotice(text: string, opts?: PostOptions) {
    const ts = this.nextTs();
    this.calls.push({ kind: "notice", text, threadTs: opts?.threadTs, ts });
    return ts;
  }
  async postButtons(text: string, buttons: DialogButton[]) {
    const ts = this.nextTs();
    this.calls.push({ kind: "buttons", text, buttons, ts });
    return ts;
  }
  async update(ts: string, text: string) {
    this.calls.push({ kind: "update", ts, text });
  }
  async remove(ts: string) {
    this.calls.push({ kind: "remove", ts });
  }
  async react(ts: string, emoji: string) {
    this.calls.push({ kind: "react", ts, emoji });
  }
  async unreact(ts: string, emoji: string) {
    this.calls.push({ kind: "unreact", ts, emoji });
  }

  texts(kind: "markdown" | "notice"): string[] {
    return this.calls.flatMap((c) => (c.kind === kind ? [c.text] : []));
  }
}

export async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 5_000, label = "condition"): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
