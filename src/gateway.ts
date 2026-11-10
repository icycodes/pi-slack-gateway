/**
 * Routes chat messages to bindings (DM → home session, channel → repo session),
 * owns the BindingSession instances, `!bind`/`!unbind`, and attachments.
 * Platform-neutral: Slack specifics are behind ChatPlatform.
 */
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { absPath, type BindingOptions, DEFAULT_TOOLS, type GatewayConfig, isDirectory, isInside } from "./config.ts";
import { slackToPlain } from "./format.ts";
import type { Logger } from "./log.ts";
import { BindingSession, type ChatSink, HELP, type InboundImage } from "./session.ts";
import type { StateStore } from "./state.ts";

export interface InboundFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Platform-specific download handle (e.g. Slack url_private_download). */
  url?: string;
}

export interface InboundEvent {
  userId: string;
  channelId: string;
  channelType: "im" | "channel" | "group" | "mpim";
  /** Raw platform text (Slack markup). */
  text: string;
  ts: string;
  threadTs?: string;
  files: InboundFile[];
}

export interface ChatPlatform {
  readonly botUserId: string;
  sinkFor(channelId: string): ChatSink;
  downloadFile(file: InboundFile, destPath: string): Promise<void>;
  channelName(channelId: string): Promise<string | undefined>;
}

export interface GatewayOptions {
  config: GatewayConfig;
  state: StateStore;
  platform: ChatPlatform;
  log: Logger;
  /** Environment for pi children (gateway secrets removed). */
  env: NodeJS.ProcessEnv;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INLINE_IMAGE = 5 * 1024 * 1024;
const MAX_DOWNLOAD = 100 * 1024 * 1024;

interface Resolved {
  key: string;
  binding: BindingOptions;
}

/** Binding for a channel bound with `!bind`: no options, so the config default tools apply. */
function dynamicBinding(cwd: string): BindingOptions {
  return { cwd, tools: DEFAULT_TOOLS };
}

export function displayPath(p: string): string {
  const home = homedir();
  return p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

export class Gateway {
  private readonly opts: GatewayOptions;
  private readonly log: Logger;
  private sessions = new Map<string, BindingSession>();
  private queues = new Map<string, Promise<void>>();

  constructor(opts: GatewayOptions) {
    this.opts = opts;
    this.log = opts.log;
  }

  private get config(): GatewayConfig {
    return this.opts.config;
  }

  isAllowed(userId: string): boolean {
    return this.config.allowedUsers.includes(userId);
  }

  private resolve(channelId: string, channelType: InboundEvent["channelType"], userId: string): Resolved | undefined {
    if (channelType === "im") return { key: `dm:${userId}`, binding: this.config.dm };
    const fixed = this.config.channels[channelId];
    if (fixed) return { key: `ch:${channelId}`, binding: fixed };
    const dynamic = this.opts.state.channels[channelId];
    if (dynamic) return { key: `ch:${channelId}`, binding: dynamicBinding(dynamic.cwd) };
    return undefined;
  }

  /** Resolve a persisted session key back to its binding (used at startup). */
  private resolveKey(key: string): Resolved | undefined {
    if (key.startsWith("dm:")) return this.isAllowed(key.slice(3)) ? { key, binding: this.config.dm } : undefined;
    if (key.startsWith("ch:")) return this.resolve(key.slice(3), "channel", "");
    return undefined;
  }

  private async label(key: string, channelId: string): Promise<string> {
    if (key.startsWith("dm:")) return "slack DM";
    const name = await this.opts.platform.channelName(channelId).catch(() => undefined);
    return name ? `slack #${name}` : `slack ${channelId}`;
  }

  private async session(resolved: Resolved, channelId: string): Promise<BindingSession> {
    const existing = this.sessions.get(resolved.key);
    if (existing) return existing;
    const { key, binding } = resolved;
    const state = this.opts.state;
    const pointer = state.sessions[key];
    const session = new BindingSession({
      key,
      label: await this.label(key, channelId),
      binding,
      config: this.config,
      sink: this.opts.platform.sinkFor(channelId),
      sessionFile: pointer?.channelId === channelId ? pointer.sessionFile : undefined,
      onSessionFile: (sessionFile) => state.setSession(key, { channelId, sessionFile }),
      env: this.opts.env,
      log: this.log,
    });
    // A concurrent call may have created it while we awaited the label.
    const raced = this.sessions.get(key);
    if (raced) return raced;
    this.sessions.set(key, session);
    state.setSession(key, { channelId, sessionFile: pointer?.channelId === channelId ? pointer.sessionFile : undefined });
    return session;
  }

  /** Run tasks for one binding strictly in arrival order. */
  private enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(task).catch((e: Error) => this.log.error("binding task failed", { binding: key, error: e }));
    this.queues.set(key, next);
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    return next;
  }

  /** Start pi for every binding that has a stored session, so background completions keep flowing. */
  async resumeAll(): Promise<void> {
    for (const [key, pointer] of Object.entries(this.opts.state.sessions)) {
      if (!pointer.sessionFile) continue;
      const resolved = this.resolveKey(key);
      if (!resolved) continue;
      const session = await this.session(resolved, pointer.channelId);
      session.ensureStarted().catch((e: Error) => this.log.error("could not resume binding", { binding: key, error: e }));
    }
  }

  async handle(ev: InboundEvent): Promise<void> {
    if (!this.isAllowed(ev.userId)) {
      this.log.debug("ignoring message from non-allowed user", { user: ev.userId, channel: ev.channelId });
      return;
    }
    if (ev.channelType === "mpim") return;

    const mention = `<@${this.opts.platform.botUserId}>`;
    const mentioned = ev.text.includes(mention);
    const raw = ev.text.split(mention).join("").trim();
    const text = slackToPlain(raw);
    const sink = this.opts.platform.sinkFor(ev.channelId);
    const reply = (t: string) => sink.postNotice(t, { threadTs: ev.threadTs });

    const cmd = /^!(bind|unbind)\b\s*(.*)$/s.exec(text);
    if (cmd && ev.channelType !== "im") {
      const key = `ch:${ev.channelId}`;
      await this.enqueue(key, () => (cmd[1] === "bind" ? this.bind(ev, cmd[2]!.trim(), reply) : this.unbind(ev, reply)));
      return;
    }

    const resolved = this.resolve(ev.channelId, ev.channelType, ev.userId);
    if (!resolved) {
      if (mentioned || text.startsWith("!")) {
        await reply("This channel isn't bound to a directory yet. Use `!bind ~/path/to/repo` (or configure it in config.json).");
      }
      return;
    }

    await this.enqueue(resolved.key, async () => {
      const session = await this.session(resolved, ev.channelId);
      const { text: withFiles, images } = await this.attachments(resolved.key, ev, text);
      if (!withFiles.trim() && images.length === 0) return;
      if (withFiles.trim() === "!help") {
        await reply(HELP);
        return;
      }
      await session.handleMessage({ userId: ev.userId, text: withFiles, ts: ev.ts, threadTs: ev.threadTs, images });
    });
  }

  private async attachments(key: string, ev: InboundEvent, text: string): Promise<{ text: string; images: InboundImage[] }> {
    if (ev.files.length === 0) return { text, images: [] };
    const dir = join(this.config.stateDir, "inbox", key.replace(/[^A-Za-z0-9_-]/g, "_"));
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    const images: InboundImage[] = [];
    for (const file of ev.files) {
      if (file.size > MAX_DOWNLOAD) {
        lines.push(`- ${file.name}: skipped (${file.size} bytes is over the ${MAX_DOWNLOAD} byte limit)`);
        continue;
      }
      const safe = file.name.replace(/[^\w.-]+/g, "_").slice(-120) || "file";
      const path = join(dir, `${ev.ts.replace(".", "-")}-${file.id}-${safe}`);
      try {
        await this.opts.platform.downloadFile(file, path);
        lines.push(`- ${path} (${file.mimeType}, ${file.size} bytes)`);
        if (IMAGE_TYPES.has(file.mimeType) && file.size <= MAX_INLINE_IMAGE) {
          images.push({ data: (await readFile(path)).toString("base64"), mimeType: file.mimeType });
        }
      } catch (e) {
        this.log.warn("attachment download failed", { file: file.name, error: e });
        lines.push(`- ${file.name}: download failed (${(e as Error).message})`);
      }
    }
    const block = `[Files attached by the user via Slack, saved locally:]\n${lines.join("\n")}`;
    return { text: text ? `${text}\n\n${block}` : block, images };
  }

  private async bind(ev: InboundEvent, pathArg: string, reply: (t: string) => Promise<unknown>): Promise<void> {
    if (this.config.channels[ev.channelId]) {
      await reply("This channel is bound in config.json; change it there.");
      return;
    }
    if (!pathArg) {
      const current = this.opts.state.channels[ev.channelId];
      await reply(current ? `Bound to \`${displayPath(current.cwd)}\`.` : "Usage: `!bind ~/path/to/repo`");
      return;
    }
    const cwd = absPath(pathArg.replace(/^`|`$/g, ""));
    if (!this.config.allowedRoots.some((root) => isInside(cwd, root))) {
      await reply(`\`${displayPath(cwd)}\` is outside the allowed roots (${this.config.allowedRoots.map((r) => `\`${displayPath(r)}\``).join(", ")}).`);
      return;
    }
    if (!isDirectory(cwd)) {
      await reply(`\`${displayPath(cwd)}\` is not a directory.`);
      return;
    }
    const key = `ch:${ev.channelId}`;
    const previous = this.sessions.get(key);
    if (previous) {
      this.sessions.delete(key);
      await previous.stop();
    }
    this.opts.state.unbindChannel(ev.channelId, key);
    this.opts.state.bindChannel(ev.channelId, cwd, ev.userId);
    const session = await this.session({ key, binding: dynamicBinding(cwd) }, ev.channelId);
    try {
      await session.ensureStarted();
      await reply(`:link: Bound this channel to \`${displayPath(cwd)}\`. Messages here now go to a pi session in that directory.`);
    } catch (e) {
      await reply(`:link: Bound to \`${displayPath(cwd)}\`, but pi failed to start: ${(e as Error).message}`);
    }
  }

  private async unbind(ev: InboundEvent, reply: (t: string) => Promise<unknown>): Promise<void> {
    if (this.config.channels[ev.channelId]) {
      await reply("This channel is bound in config.json; change it there.");
      return;
    }
    const key = `ch:${ev.channelId}`;
    if (!this.opts.state.channels[ev.channelId]) {
      await reply("This channel isn't bound.");
      return;
    }
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    await session?.stop();
    this.opts.state.unbindChannel(ev.channelId, key);
    await reply(":broken_chain: Unbound. The pi session file is kept on disk.");
  }

  /** Dialog button pressed. Returns false when the dialog is no longer pending. */
  handleDialogAction(userId: string, value: string): boolean {
    if (!this.isAllowed(userId)) return false;
    let parsed: { k?: unknown; r?: unknown; i?: unknown };
    try {
      parsed = JSON.parse(value) as typeof parsed;
    } catch {
      return false;
    }
    if (typeof parsed.k !== "string" || typeof parsed.r !== "string" || typeof parsed.i !== "number") return false;
    return this.sessions.get(parsed.k)?.handleDialogAction(parsed.r, parsed.i) ?? false;
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((s) => s.stop()));
  }
}
