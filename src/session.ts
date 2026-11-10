/**
 * One binding (a DM or a channel) ⇄ one long-lived `pi --mode rpc` process.
 *
 * Responsibilities:
 *  - spawn pi lazily, resume the binding's session file, respawn with backoff on crash
 *  - forward user messages as prompts (steering when a run is active)
 *  - post every final assistant message, including turns pi starts on its own
 *    (e.g. pi-subagents waking the agent when a background run completes)
 *  - maintain a live "working…" status message while a run is active
 *  - bridge extension UI dialogs to chat (buttons / next-message answers)
 *  - gateway commands: !stop !new !status !model !thinking !compact !restart !later !cancel
 *
 * Chat-platform specifics live behind the ChatSink interface (see slack.ts).
 */
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { BindingOptions, GatewayConfig } from "./config.ts";
import { isDirectory } from "./config.ts";
import {
  type AssistantLike,
  type SubagentRun,
  describeRuns,
  describeTool,
  formatDuration,
  isActiveRun,
  messageText,
  parseSendFileDirectives,
  parseSubagentSnapshot,
  truncate,
} from "./format.ts";
import type { Logger } from "./log.ts";
import { PiRpc, type RpcRecord } from "./pi-rpc.ts";

export interface PostOptions {
  threadTs?: string;
}

export interface UploadOptions {
  caption?: string;
  filename?: string;
  threadTs?: string;
}

export interface DialogButton {
  label: string;
  /** Opaque value round-tripped through the chat platform's interaction payload. */
  value: string;
  style?: "primary" | "danger";
}

export interface ChatSink {
  /** Post agent-authored markdown (may be split). Returns the ts of the first message. */
  postMarkdown(markdown: string, opts?: PostOptions): Promise<string | undefined>;
  /** Post a short gateway notice (Slack mrkdwn). */
  postNotice(text: string, opts?: PostOptions): Promise<string | undefined>;
  postButtons(text: string, buttons: DialogButton[], opts?: PostOptions): Promise<string | undefined>;
  update(ts: string, text: string): Promise<void>;
  remove(ts: string): Promise<void>;
  react(ts: string, emoji: string): Promise<void>;
  unreact(ts: string, emoji: string): Promise<void>;
  /** Upload a local file to the conversation. */
  uploadFile(path: string, opts?: UploadOptions): Promise<void>;
}

export interface InboundImage {
  data: string;
  mimeType: string;
}

export interface InboundMessage {
  userId: string;
  /** Plain text (already converted from Slack markup, attachments listed). */
  text: string;
  ts: string;
  /** Set when the message was posted inside a thread. */
  threadTs?: string;
  images?: InboundImage[];
}

export interface SessionOptions {
  key: string;
  /** Human label, used for the initial session name. */
  label: string;
  binding: BindingOptions;
  config: GatewayConfig;
  sink: ChatSink;
  sessionFile?: string;
  onSessionFile: (sessionFile: string | undefined) => void;
  env: NodeJS.ProcessEnv;
  log: Logger;
  /** Override for tests. */
  restartBackoffMs?: (attempt: number) => number;
}

interface PiModel {
  id: string;
  provider: string;
  input?: string[];
  contextWindow?: number;
}

interface PiState {
  model?: PiModel;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
  pendingMessageCount?: number;
}

interface SessionStats {
  tokens?: { total?: number };
  cost?: number;
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null };
}

interface ActiveRun {
  startedAt: number;
  threadTs?: string;
  statusTs?: string;
  statusText?: string;
  statusPosting?: Promise<void>;
  activity?: string;
  note?: string;
  error?: string;
  timer?: NodeJS.Timeout;
}

interface Dialog {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  options: string[];
  ts?: string;
  timer?: NodeJS.Timeout;
}

const MAX_CRASHES = 5;
const HEALTHY_UPTIME_MS = 10 * 60_000;
const ACK_EMOJI = "eyes";
/** Outbound file size limit, symmetric with the inbound download limit. */
export const MAX_UPLOAD = 100 * 1024 * 1024;

export const HELP = [
  "*Commands*",
  "• `!status` — model, context, queue, background subagents",
  "• `!stop` — abort the current run and clear queued messages",
  "• `!new` — start a fresh pi session for this channel",
  "• `!later <text>` — queue a follow-up for after the current run (plain messages steer)",
  "• `!model [provider/id]` — show or switch the model",
  "• `!thinking <level>` — off, minimal, low, medium, high, xhigh, max",
  "• `!compact [instructions]` — compact the conversation context",
  "• `!restart` — restart the pi process (same session)",
  "• `!cancel` — dismiss a pending question from an extension",
  "• `!bind <path>` / `!unbind` — (channels) attach this channel to a directory",
].join("\n");

/** Read-only tools a manager uses to verify work; shown as inspection rather than work. */
const INSPECTION_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** Status line for a running tool: inspection, delegation, or inline work. */
function toolActivity(toolName: string, args: unknown): string {
  const icon = INSPECTION_TOOLS.has(toolName) ? ":mag:" : toolName === "subagent" ? ":jigsaw:" : ":wrench:";
  return `${icon} ${describeTool(toolName, args)}`;
}

/**
 * `!status` cost line. pi reports a flat `cost` of 0 for models without pricing
 * metadata and exposes no "cost unknown" flag in get_session_stats, so zero cost
 * with tokens spent means unknown, not free.
 */
export function formatCostLine(cost: number, totalTokens: number | undefined): string {
  const tokens = `${totalTokens?.toLocaleString("en-US") ?? "?"} tokens total`;
  if (cost === 0 && totalTokens !== undefined && totalTokens > 0) return `*Cost* unknown (no pricing for this model) · ${tokens}`;
  return `*Cost* $${cost.toFixed(4)} · ${tokens}`;
}

export class BindingSession {
  readonly key: string;
  readonly binding: BindingOptions;
  private readonly opts: SessionOptions;
  private readonly log: Logger;
  private rpc?: PiRpc;
  private starting?: Promise<PiRpc>;
  private startedAt = 0;
  private stopping = false;
  private crashes = 0;
  private restartTimer?: NodeJS.Timeout;
  private stderrTail: string[] = [];

  private state: PiState = {};
  private sessionFile?: string;
  private run?: ActiveRun;
  /** Thread to answer in for the next run we start ourselves. */
  private nextThreadTs?: string;
  private acked: string[] = [];
  private dialogs = new Map<string, Dialog>();
  private subagents: SubagentRun[] = [];
  private widgets = new Map<string, string[]>();
  private statuses = new Map<string, string>();

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.key = opts.key;
    this.binding = opts.binding;
    this.sessionFile = opts.sessionFile;
    this.log = opts.log.child({ binding: opts.key });
  }

  get running(): boolean {
    return this.run !== undefined;
  }

  get alive(): boolean {
    return this.rpc?.alive ?? false;
  }

  // ---------------------------------------------------------------------------
  // Process lifecycle
  // ---------------------------------------------------------------------------

  /** Start pi if it is not running. Resolves once pi answered `get_state`. */
  ensureStarted(): Promise<PiRpc> {
    if (this.rpc?.alive && !this.starting) return Promise.resolve(this.rpc);
    if (!this.starting) {
      this.stopping = false;
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
      this.starting = this.spawn().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  private buildArgs(): string[] {
    const { binding } = this;
    const { config, label } = this.opts;
    const args = ["--mode", "rpc"];
    if (this.sessionFile && existsSync(this.sessionFile)) args.push("--session", this.sessionFile);
    else args.push("--name", binding.name ?? label);
    if (binding.model) args.push("--model", binding.model);
    if (binding.thinking) args.push("--thinking", binding.thinking);
    if (binding.tools) args.push("--tools", binding.tools);
    if (config.pi.appendSystemPrompt) args.push("--append-system-prompt", config.pi.appendSystemPrompt);
    args.push(...config.pi.args);
    return args;
  }

  private async spawn(): Promise<PiRpc> {
    const cwd = this.binding.cwd;
    if (!isDirectory(cwd)) throw new Error(`working directory does not exist: ${cwd}`);
    const rpc = new PiRpc({
      command: this.opts.config.pi.command,
      args: this.buildArgs(),
      cwd,
      env: this.opts.env,
      log: this.log,
    });
    this.stderrTail = [];
    rpc.on("event", (ev) => this.onEvent(ev));
    rpc.on("stderr", (line) => {
      this.log.debug("pi stderr", { line });
      this.stderrTail.push(line);
      if (this.stderrTail.length > 15) this.stderrTail.shift();
    });
    rpc.on("exit", (code, signal) => this.onExit(rpc, code, signal));
    this.rpc = rpc;
    this.startedAt = Date.now();
    rpc.start();
    try {
      this.applyState(await rpc.request<PiState>({ type: "get_state" }, 120_000));
    } catch (e) {
      if (rpc.alive) await rpc.stop(1_000);
      const tail = this.stderrTail.join("\n").trim();
      throw new Error(`pi failed to start: ${(e as Error).message}${tail ? `\n${tail}` : ""}`);
    }
    this.log.info("pi ready", { pid: rpc.pid, sessionFile: this.sessionFile, model: this.state.model?.id });
    return rpc;
  }

  private applyState(state: PiState): void {
    this.state = state;
    if (state.sessionFile !== this.sessionFile) {
      this.sessionFile = state.sessionFile;
      this.opts.onSessionFile(state.sessionFile);
    }
  }

  private async refreshState(): Promise<PiState> {
    const rpc = await this.ensureStarted();
    this.applyState(await rpc.request<PiState>({ type: "get_state" }));
    return this.state;
  }

  private onExit(rpc: PiRpc, code: number | null, signal: NodeJS.Signals | null): void {
    if (rpc !== this.rpc) return;
    this.rpc = undefined;
    void this.finishRun({ silent: true });
    for (const d of this.dialogs.values()) this.closeDialog(d, "_(pi exited)_");
    if (this.stopping) {
      this.log.info("pi stopped", { code, signal });
      return;
    }
    // A failure during startup is reported by whoever awaited ensureStarted().
    if (this.starting) return;
    const uptime = Date.now() - this.startedAt;
    if (uptime > HEALTHY_UPTIME_MS) this.crashes = 0;
    const tail = this.stderrTail.join("\n").trim();
    this.log.warn("pi exited unexpectedly", { code, signal, uptime, stderr: tail });
    const detail = tail ? `\n\`\`\`\n${tail.slice(-1500)}\n\`\`\`` : "";
    this.scheduleRestart(`pi exited (code ${code ?? signal})`, detail);
  }

  private scheduleRestart(reason: string, detail = ""): void {
    this.crashes++;
    if (this.crashes > MAX_CRASHES) {
      void this.notice(`:warning: ${reason}; giving up after ${MAX_CRASHES} automatic restarts. Send a message or \`!restart\` to try again.${detail}`);
      return;
    }
    const delay = this.opts.restartBackoffMs?.(this.crashes) ?? Math.min(5_000 * 2 ** (this.crashes - 1), 5 * 60_000);
    void this.notice(`:warning: ${reason}; restarting in ${formatDuration(delay)}.${detail}`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stopping) return;
      this.ensureStarted().catch((e: Error) => {
        this.log.error("restart failed", { error: e });
        this.scheduleRestart("restart failed", `\n\`\`\`\n${e.message.slice(-1500)}\n\`\`\``);
      });
    }, delay);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    if (this.run?.timer) clearInterval(this.run.timer);
    const rpc = this.rpc;
    if (rpc) await rpc.stop();
  }

  // ---------------------------------------------------------------------------
  // Inbound chat
  // ---------------------------------------------------------------------------

  async handleMessage(msg: InboundMessage): Promise<void> {
    const text = msg.text.trim();
    const input = [...this.dialogs.values()].find((d) => d.method === "input" || d.method === "editor");
    if (input && !text.startsWith("!")) {
      this.answerDialog(input, { value: msg.text }, `:writing_hand: answered`);
      return;
    }
    if (text.startsWith("!")) {
      const [, name = "", rest = ""] = /^!(\S*)\s*([\s\S]*)$/.exec(text) ?? [];
      await this.command(name.toLowerCase(), rest.trim(), msg);
      return;
    }
    await this.prompt(msg, "steer");
  }

  private async prompt(msg: InboundMessage, behavior: "steer" | "followUp"): Promise<void> {
    let rpc: PiRpc;
    if (!this.alive && this.crashes > MAX_CRASHES) this.crashes = 0;
    try {
      rpc = await this.ensureStarted();
    } catch (e) {
      await this.notice(`:x: ${(e as Error).message}`, msg.threadTs);
      return;
    }
    const images = msg.images?.length && this.state.model?.input?.includes("image") ? msg.images : undefined;
    let text = msg.text;
    if (msg.images?.length && !images) text += "\n\n(The current model has no image input; use the saved file paths instead.)";
    if (!text.trim() && !images) return;

    await this.ack(msg.ts);
    if (!this.run) this.nextThreadTs = msg.threadTs;
    try {
      const res = await rpc.request<{ disposition?: string }>({
        type: "prompt",
        message: text,
        ...(images ? { images: images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })) } : {}),
        streamingBehavior: behavior,
      });
      if (res?.disposition === "handled") {
        await this.unack(msg.ts);
        await this.opts.sink.react(msg.ts, "white_check_mark");
      } else if (res?.disposition === "queued") {
        await this.opts.sink.react(msg.ts, behavior === "followUp" ? "hourglass_flowing_sand" : "arrow_right_hook");
      }
    } catch (e) {
      await this.unack(msg.ts);
      await this.notice(`:x: prompt rejected: ${(e as Error).message}`, msg.threadTs);
    }
  }

  private async ack(ts: string): Promise<void> {
    this.acked.push(ts);
    await this.opts.sink.react(ts, ACK_EMOJI);
  }

  private async unack(ts: string): Promise<void> {
    this.acked = this.acked.filter((t) => t !== ts);
    await this.opts.sink.unreact(ts, ACK_EMOJI);
  }

  private notice(text: string, threadTs?: string): Promise<string | undefined> {
    return this.opts.sink.postNotice(text, { threadTs }).catch((e: Error) => {
      this.log.error("failed to post notice", { error: e });
      return undefined;
    });
  }

  private post(markdown: string, threadTs?: string): Promise<string | undefined> {
    return this.opts.sink.postMarkdown(markdown, { threadTs }).catch((e: Error) => {
      this.log.error("failed to post message", { error: e });
      return undefined;
    });
  }

  /** Post a final reply, uploading any `[send-file: …]` directives it contains. Never throws. */
  private async deliver(reply: string, threadTs?: string): Promise<void> {
    const { files, text } = parseSendFileDirectives(reply);
    if (text.trim()) await this.post(text, threadTs);
    for (const file of files) {
      try {
        await this.uploadFile(file.path, file.caption, threadTs);
      } catch (e) {
        const reason = (e as Error).message || String(e);
        this.log.warn("file upload failed", { path: file.path, error: reason });
        await this.notice(`:warning: could not send ${file.path}: ${reason}`, threadTs);
      }
    }
  }

  private async uploadFile(path: string, caption: string | undefined, threadTs: string | undefined): Promise<void> {
    const expanded = path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
    let real: string;
    try {
      real = await realpath(resolve(this.binding.cwd, expanded));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw new Error(code === "ENOENT" || code === "ENOTDIR" ? "file not found" : (e as Error).message);
    }
    const info = await stat(real);
    if (info.isDirectory()) throw new Error("is a directory");
    if (!info.isFile()) throw new Error("not a regular file");
    if (info.size > MAX_UPLOAD) throw new Error(`${info.size} bytes is over the ${MAX_UPLOAD} byte limit`);
    await this.opts.sink.uploadFile(real, { caption, filename: basename(expanded), threadTs });
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  private async command(name: string, arg: string, msg: InboundMessage): Promise<void> {
    const reply = (text: string) => this.notice(text, msg.threadTs);
    try {
      switch (name) {
        case "help":
          await reply(HELP);
          return;
        case "later":
          if (!arg) await reply("Usage: `!later <text>`");
          else await this.prompt({ ...msg, text: arg }, "followUp");
          return;
        case "cancel": {
          if (this.dialogs.size === 0) await reply("Nothing to cancel.");
          for (const d of [...this.dialogs.values()]) this.answerDialog(d, { cancelled: true }, ":no_entry_sign: cancelled");
          return;
        }
        case "status":
          await reply(await this.statusReport());
          return;
        case "restart":
          await reply(":arrows_counterclockwise: restarting pi…");
          await this.stop();
          this.crashes = 0;
          await this.ensureStarted();
          await reply(`:white_check_mark: pi restarted (${this.describeModel()}).`);
          return;
      }

      const rpc = await this.ensureStarted();
      switch (name) {
        case "stop": {
          const wasRunning = this.running;
          const cleared = await rpc.request<{ steering?: string[]; followUp?: string[] }>({ type: "clear_queue" });
          await rpc.request({ type: "abort" }, 120_000);
          const dropped = (cleared?.steering?.length ?? 0) + (cleared?.followUp?.length ?? 0);
          if (!wasRunning) await reply(dropped ? `Dropped ${dropped} queued message(s).` : "Nothing is running.");
          else if (dropped) await reply(`Dropped ${dropped} queued message(s).`);
          return;
        }
        case "new": {
          if (this.running) {
            await rpc.request({ type: "clear_queue" });
            await rpc.request({ type: "abort" }, 120_000);
          }
          const res = await rpc.request<{ cancelled?: boolean }>({ type: "new_session" });
          if (res?.cancelled) {
            await reply("An extension cancelled the new session.");
            return;
          }
          if (this.opts.label) await rpc.request({ type: "set_session_name", name: this.binding.name ?? this.opts.label }).catch(() => undefined);
          await this.refreshState();
          await reply(":sparkles: Started a new session.");
          return;
        }
        case "model": {
          if (!arg) {
            const res = await rpc.request<{ models?: PiModel[] }>({ type: "get_available_models" });
            const list = (res?.models ?? []).map((m) => `\`${m.provider}/${m.id}\``);
            await reply(`Current: ${this.describeModel()}\nAvailable: ${list.slice(0, 60).join(", ") || "(none)"}${list.length > 60 ? ", …" : ""}`);
            return;
          }
          const model = await this.resolveModel(rpc, arg);
          if (!model) {
            await reply(`Unknown model \`${arg}\`. Try \`!model\` for the list.`);
            return;
          }
          await rpc.request({ type: "set_model", provider: model.provider, modelId: model.id });
          await this.refreshState();
          await reply(`Model set to ${this.describeModel()}.`);
          return;
        }
        case "thinking": {
          if (!arg) {
            const res = await rpc.request<{ levels?: string[] }>({ type: "get_available_thinking_levels" });
            await reply(`Thinking: \`${this.state.thinkingLevel ?? "?"}\`; available: ${(res?.levels ?? []).map((l) => `\`${l}\``).join(", ")}`);
            return;
          }
          await rpc.request({ type: "set_thinking_level", level: arg });
          await this.refreshState();
          await reply(`Thinking level set to \`${this.state.thinkingLevel ?? arg}\`.`);
          return;
        }
        case "compact": {
          await reply(":compression: compacting…");
          const res = await rpc.request<{ tokensBefore?: number; estimatedTokensAfter?: number }>(
            { type: "compact", ...(arg ? { customInstructions: arg } : {}) },
            15 * 60_000,
          );
          await reply(`:white_check_mark: Compacted (${res?.tokensBefore ?? "?"} → ~${res?.estimatedTokensAfter ?? "?"} tokens).`);
          return;
        }
        default:
          await reply(`Unknown command \`!${name}\`.\n${HELP}`);
      }
    } catch (e) {
      this.log.warn("command failed", { command: name, error: e });
      await reply(`:x: \`!${name}\` failed: ${(e as Error).message}`);
    }
  }

  private async resolveModel(rpc: PiRpc, arg: string): Promise<PiModel | undefined> {
    const res = await rpc.request<{ models?: PiModel[] }>({ type: "get_available_models" });
    const models = res?.models ?? [];
    const slash = arg.indexOf("/");
    if (slash > 0) {
      const provider = arg.slice(0, slash);
      const id = arg.slice(slash + 1);
      return models.find((m) => m.provider === provider && m.id === id);
    }
    const matches = models.filter((m) => m.id === arg);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private describeModel(): string {
    const m = this.state.model;
    const model = m ? `\`${m.provider}/${m.id}\`` : "`(no model)`";
    return this.state.thinkingLevel ? `${model} · thinking \`${this.state.thinkingLevel}\`` : model;
  }

  async statusReport(): Promise<string> {
    const lines: string[] = [`*Directory* \`${this.binding.cwd}\``];
    if (!this.alive) {
      lines.push("*pi* not running (starts on the next message)");
      if (this.sessionFile) lines.push(`*Session* \`${this.sessionFile}\``);
      return lines.join("\n");
    }
    const rpc = await this.ensureStarted();
    const [state, stats] = await Promise.all([
      this.refreshState(),
      rpc.request<SessionStats>({ type: "get_session_stats" }).catch(() => undefined),
    ]);
    const name = state.sessionName ? ` (${state.sessionName})` : "";
    lines.push(`*Session* \`${state.sessionId?.slice(0, 8) ?? "?"}\`${name} · ${state.messageCount ?? 0} messages`);
    lines.push(`*Model* ${this.describeModel()}`);
    if (this.run) {
      const act = this.run.activity ? ` · ${this.run.activity}` : "";
      lines.push(`*State* working for ${formatDuration(Date.now() - this.run.startedAt)}${act}`);
    } else {
      lines.push(`*State* ${state.isCompacting ? "compacting" : "idle"}`);
    }
    if (state.pendingMessageCount) lines.push(`*Queued* ${state.pendingMessageCount} message(s)`);
    const ctx = stats?.contextUsage;
    if (ctx) {
      const pct = ctx.percent == null ? "?" : `${ctx.percent < 10 ? ctx.percent.toFixed(1).replace(/\.0$/, "") : Math.round(ctx.percent)}%`;
      lines.push(`*Context* ${pct} of ${ctx.contextWindow?.toLocaleString("en-US") ?? "?"} tokens`);
    }
    if (stats?.cost !== undefined) lines.push(formatCostLine(stats.cost, stats.tokens?.total));
    const runs = this.subagents;
    if (runs.length > 0) lines.push(`*Subagents*\n${describeRuns(runs).join("\n")}`);
    else lines.push("*Subagents* none tracked");
    for (const [key, text] of this.statuses) lines.push(`*${key}* ${truncate(text, 200)}`);
    for (const [key, widgetLines] of this.widgets) {
      if (widgetLines.length) lines.push(`*${key}*\n\`\`\`\n${widgetLines.slice(0, 15).join("\n")}\n\`\`\``);
    }
    lines.push(`_pi pid ${rpc.pid ?? "?"}, up ${formatDuration(Date.now() - this.startedAt)}_`);
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Events from pi
  // ---------------------------------------------------------------------------

  private onEvent(ev: RpcRecord): void {
    switch (ev.type) {
      case "agent_start":
        this.beginRun();
        break;
      case "agent_settled":
        void this.finishRun({ aborted: ev.aborted === true });
        break;
      case "tool_execution_start":
        if (this.run) this.run.activity = toolActivity(String(ev.toolName), ev.args);
        break;
      case "tool_execution_end":
        if (this.run) this.run.activity = ":thought_balloon: thinking";
        break;
      case "turn_start":
        if (this.run) this.run.activity = ":thought_balloon: thinking";
        break;
      case "auto_retry_start":
        if (this.run) {
          this.run.error = undefined;
          this.run.activity = `:repeat: retry ${String(ev.attempt)}/${String(ev.maxAttempts)} after: ${truncate(String(ev.errorMessage ?? ""), 120)}`;
        }
        break;
      case "auto_retry_end":
        if (ev.success === false && this.run) this.run.error = String(ev.finalError ?? this.run.error ?? "retries exhausted");
        break;
      case "compaction_start":
        if (this.run) this.run.activity = ":compression: compacting context";
        else if (ev.reason !== "manual") void this.notice(":compression: compacting context…");
        break;
      case "compaction_end":
        if (ev.errorMessage) void this.notice(`:warning: compaction failed: ${String(ev.errorMessage)}`, this.run?.threadTs);
        break;
      case "message_end":
        this.onMessageEnd(ev.message as AssistantLike | undefined);
        break;
      case "extension_ui_request":
        this.onUiRequest(ev);
        break;
      case "extension_error":
        this.log.warn("extension error", { extension: ev.extensionPath, event: ev.event, error: ev.error });
        break;
      default:
        break;
    }
  }

  private onMessageEnd(message: AssistantLike | undefined): void {
    if (!message || message.role !== "assistant") return;
    const text = messageText(message);
    const threadTs = this.run?.threadTs;
    switch (message.stopReason) {
      case "toolUse":
        if (text && this.run) this.run.note = text;
        break;
      case "error":
        if (this.run) this.run.error = message.errorMessage ?? "unknown error";
        else void this.notice(`:warning: ${message.errorMessage ?? "unknown error"}`);
        break;
      case "aborted":
        break;
      case "stop":
      case "length":
        if (text) void this.deliver(message.stopReason === "length" ? `${text}\n\n_(output truncated: max tokens)_` : text, threadTs);
        if (this.run) this.run.note = undefined;
        break;
      default:
        break;
    }
  }

  private beginRun(): void {
    if (this.run) return;
    const run: ActiveRun = { startedAt: Date.now(), threadTs: this.nextThreadTs, activity: ":thought_balloon: thinking" };
    this.nextThreadTs = undefined;
    this.run = run;
    const { statusDelayMs, statusIntervalMs } = this.opts.config;
    const tick = () => {
      if (this.run !== run) return;
      if (Date.now() - run.startedAt >= statusDelayMs) void this.renderStatus(run);
    };
    run.timer = setInterval(tick, Math.max(250, Math.min(statusIntervalMs, statusDelayMs || statusIntervalMs)));
    run.timer.unref();
  }

  private statusText(run: ActiveRun): string {
    const lines = [`:hourglass_flowing_sand: working · ${formatDuration(Date.now() - run.startedAt)}`];
    const active = this.subagents.filter(isActiveRun);
    if (active.length) lines.push(`:jigsaw: ${active.length} subagent${active.length > 1 ? "s" : ""} running: ${active.map((r) => r.label).join(", ")}`);
    if (run.activity) lines.push(run.activity);
    if (run.note) lines.push(`> ${truncate(run.note, 280)}`);
    lines.push("_`!stop` to abort · messages you send now steer the run_");
    return lines.join("\n");
  }

  private async renderStatus(run: ActiveRun): Promise<void> {
    if (run.statusPosting) return;
    const { statusIntervalMs } = this.opts.config;
    const text = this.statusText(run);
    if (text === run.statusText) return;
    run.statusPosting = (async () => {
      try {
        if (!run.statusTs) {
          run.statusTs = await this.opts.sink.postNotice(text, { threadTs: run.threadTs });
          if (this.run !== run && run.statusTs) await this.opts.sink.remove(run.statusTs);
        } else {
          await this.opts.sink.update(run.statusTs, text);
        }
        run.statusText = text;
      } catch (e) {
        this.log.warn("status update failed", { error: e });
      }
      // Throttle edits: hold the "posting" slot for the interval.
      await new Promise((r) => setTimeout(r, statusIntervalMs).unref());
    })().finally(() => {
      run.statusPosting = undefined;
    });
  }

  private async finishRun({ aborted = false, silent = false }: { aborted?: boolean; silent?: boolean }): Promise<void> {
    const run = this.run;
    this.run = undefined;
    this.nextThreadTs = undefined;
    const acked = this.acked;
    this.acked = [];
    if (run?.timer) clearInterval(run.timer);
    await Promise.all(acked.map((ts) => this.opts.sink.unreact(ts, ACK_EMOJI).catch(() => undefined)));
    if (run) {
      if (!silent && run.error) await this.notice(`:warning: ${run.error}`, run.threadTs);
      if (!silent && aborted) await this.notice(":stop_button: Stopped.", run.threadTs);
      // Wait for an in-flight status post so we know its ts, then remove it.
      if (run.statusPosting && !run.statusTs) await Promise.race([run.statusPosting, new Promise((r) => setTimeout(r, 3_000).unref())]);
      if (run.statusTs) await this.opts.sink.remove(run.statusTs).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Extension UI bridge
  // ---------------------------------------------------------------------------

  private onUiRequest(ev: RpcRecord): void {
    const id = String(ev.id ?? "");
    const method = String(ev.method ?? "");
    switch (method) {
      case "notify": {
        const level = String(ev.notifyType ?? "info");
        const policy = this.opts.config.notify;
        const message = String(ev.message ?? "");
        this.log.info("extension notify", { level, message });
        if (policy === "none" || (policy === "warnings" && level === "info")) return;
        const icon = level === "error" ? ":x:" : level === "warning" ? ":warning:" : ":information_source:";
        void this.notice(`${icon} ${message}`, this.run?.threadTs);
        return;
      }
      case "setWidget": {
        const key = String(ev.widgetKey ?? "");
        const lines = Array.isArray(ev.widgetLines) ? ev.widgetLines.map(String) : undefined;
        const runs = parseSubagentSnapshot(lines);
        if (runs) this.subagents = runs;
        else if (key === "subagent-async" && !lines) this.subagents = [];
        else if (lines?.length) this.widgets.set(key, lines);
        else this.widgets.delete(key);
        return;
      }
      case "setStatus": {
        const key = String(ev.statusKey ?? "");
        if (typeof ev.statusText === "string" && ev.statusText) this.statuses.set(key, ev.statusText);
        else this.statuses.delete(key);
        return;
      }
      case "select":
      case "confirm":
      case "input":
      case "editor":
        void this.openDialog(id, method, ev);
        return;
      default:
        return; // setTitle, set_editor_text: nothing to show in chat
    }
  }

  private async openDialog(id: string, method: Dialog["method"], ev: RpcRecord): Promise<void> {
    const title = String(ev.title ?? "Question");
    const options = method === "select" && Array.isArray(ev.options) ? ev.options.map(String) : method === "confirm" ? ["Yes", "No"] : [];
    const dialog: Dialog = { id, method, title, options };
    this.dialogs.set(id, dialog);
    const threadTs = this.run?.threadTs;
    const header = `:question: *${title}*${typeof ev.message === "string" && ev.message ? `\n${ev.message}` : ""}`;
    if (method === "select" || method === "confirm") {
      const buttons: DialogButton[] = options.slice(0, 20).map((label, i) => ({
        label: truncate(label, 75),
        value: JSON.stringify({ k: this.key, r: id, i }),
        ...(method === "confirm" ? { style: i === 0 ? ("primary" as const) : ("danger" as const) } : {}),
      }));
      buttons.push({ label: "Cancel", value: JSON.stringify({ k: this.key, r: id, i: -1 }) });
      dialog.ts = await this.opts.sink.postButtons(header, buttons, { threadTs }).catch(() => undefined);
    } else {
      const prefill = typeof ev.prefill === "string" && ev.prefill ? `\n\`\`\`\n${ev.prefill}\n\`\`\`` : "";
      const hint = typeof ev.placeholder === "string" && ev.placeholder ? ` (${ev.placeholder})` : "";
      dialog.ts = await this.notice(`${header}${prefill}\n_Reply with your answer${hint}, or \`!cancel\`._`, threadTs);
    }
    if (typeof ev.timeout === "number" && ev.timeout > 0) {
      dialog.timer = setTimeout(() => {
        if (this.dialogs.get(id) === dialog) this.closeDialog(dialog, ":hourglass: _timed out_");
      }, ev.timeout);
      dialog.timer.unref();
    }
  }

  /** Called by the chat adapter when a dialog button is pressed. Returns false if the dialog is gone. */
  handleDialogAction(requestId: string, index: number): boolean {
    const dialog = this.dialogs.get(requestId);
    if (!dialog) return false;
    if (index < 0) {
      this.answerDialog(dialog, { cancelled: true }, ":no_entry_sign: cancelled");
      return true;
    }
    const choice = dialog.options[index];
    if (choice === undefined) return false;
    const response = dialog.method === "confirm" ? { confirmed: index === 0 } : { value: choice };
    this.answerDialog(dialog, response, `:white_check_mark: ${choice}`);
    return true;
  }

  private answerDialog(dialog: Dialog, response: Record<string, unknown>, summary: string): void {
    try {
      this.rpc?.send({ type: "extension_ui_response", id: dialog.id, ...response });
    } catch (e) {
      this.log.warn("could not answer dialog", { error: e });
    }
    this.closeDialog(dialog, summary);
  }

  private closeDialog(dialog: Dialog, summary: string): void {
    this.dialogs.delete(dialog.id);
    if (dialog.timer) clearTimeout(dialog.timer);
    if (dialog.ts) void this.opts.sink.update(dialog.ts, `:question: *${dialog.title}* → ${summary}`).catch(() => undefined);
  }
}
