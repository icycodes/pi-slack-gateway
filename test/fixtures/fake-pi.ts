#!/usr/bin/env node
/**
 * Scriptable stand-in for `pi --mode rpc` used by the tests.
 *
 * Prompts with special text trigger behaviors:
 *   "crash"   → exit(3) immediately
 *   "ask"     → extension select dialog, then echo the answer
 *   "slow"    → a run with a bash tool call that lasts ~400ms
 *   "unicode" → assistant text containing U+2028
 *   "fail"    → assistant error message
 *   "say:<x>" → assistant text exactly <x>
 *   anything else → "echo: <text>"
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const sessionDir = process.env.FAKE_PI_SESSION_DIR ?? "/tmp/fake-pi-sessions";
mkdirSync(sessionDir, { recursive: true });

const sessionArg = argv.indexOf("--session");
let sessionFile = sessionArg >= 0 ? argv[sessionArg + 1]! : join(sessionDir, `s-${process.pid}-${Date.now()}.jsonl`);
let streaming = false;
const uiWaiters = new Map<string, (r: Record<string, unknown>) => void>();

function out(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function respond(cmd: Record<string, unknown>, data?: unknown, error?: string): void {
  out({ type: "response", id: cmd.id, command: cmd.type, success: !error, ...(error ? { error } : { data }) });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assistant(text: string, stopReason = "stop", errorMessage?: string): void {
  const message = { role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason, ...(errorMessage ? { errorMessage } : {}) };
  out({ type: "message_start", message: { ...message, stopReason: "pending", content: [] } });
  out({ type: "message_end", message });
}

async function run(text: string): Promise<void> {
  streaming = true;
  appendFileSync(sessionFile, `${JSON.stringify({ type: "message", text })}\n`);
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  out({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
  if (text === "ask") {
    const answer = await new Promise<Record<string, unknown>>((resolve) => {
      uiWaiters.set("ui-1", resolve);
      out({ type: "extension_ui_request", id: "ui-1", method: "select", title: "Pick one", options: ["A", "B"] });
    });
    assistant(`chose ${answer.cancelled ? "nothing" : String(answer.value)}`);
  } else if (text === "slow") {
    assistant("working on it", "toolUse");
    out({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "sleep 1" } });
    await sleep(400);
    out({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false });
    assistant("done slow");
  } else if (text === "unicode") {
    assistant("line\u2028sep");
  } else if (text.startsWith("say:")) {
    assistant(text.slice(4));
  } else if (text === "fail") {
    assistant("", "error", "provider exploded");
  } else {
    assistant(`echo: ${text}`);
  }
  out({ type: "turn_end" });
  out({ type: "agent_end", messages: [], willRetry: false });
  streaming = false;
  out({ type: "agent_settled", aborted: false });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let i: number;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line) as Record<string, unknown>);
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(cmd: Record<string, unknown>): void {
  switch (cmd.type) {
    case "get_state":
      respond(cmd, {
        model: { id: "fake-model", provider: "test", input: ["text"], contextWindow: 1000 },
        thinkingLevel: "off",
        isStreaming: streaming,
        isCompacting: false,
        sessionFile,
        sessionId: sessionFile.replace(/.*\//, ""),
        messageCount: 0,
        pendingMessageCount: 0,
        argv,
      });
      return;
    case "get_session_stats":
      respond(cmd, { tokens: { total: 42 }, cost: 0.01, contextUsage: { tokens: 10, contextWindow: 1000, percent: 1 } });
      return;
    case "prompt": {
      const text = String(cmd.message);
      if (text === "crash") process.exit(3);
      if (streaming && !cmd.streamingBehavior) return respond(cmd, undefined, "streamingBehavior required");
      respond(cmd, { disposition: streaming ? "queued" : "started" });
      if (!streaming) void run(text);
      return;
    }
    case "extension_ui_response": {
      const waiter = uiWaiters.get(String(cmd.id));
      uiWaiters.delete(String(cmd.id));
      waiter?.(cmd);
      return;
    }
    case "clear_queue":
      return respond(cmd, { steering: [], followUp: [] });
    case "abort":
      return respond(cmd);
    case "new_session":
      sessionFile = join(sessionDir, `s-${process.pid}-${Date.now()}-new.jsonl`);
      return respond(cmd, { cancelled: false });
    case "set_session_name":
      return respond(cmd);
    default:
      return respond(cmd, undefined, `unsupported command: ${String(cmd.type)}`);
  }
}
