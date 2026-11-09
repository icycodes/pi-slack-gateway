/** Slack adapter: Socket Mode (no public URL), Block Kit markdown, reactions, buttons, file downloads. */
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { App, type BlockAction, type ButtonAction, LogLevel } from "@slack/bolt";
import { splitMarkdown, truncate } from "./format.ts";
import type { ChatPlatform, InboundEvent, InboundFile } from "./gateway.ts";
import type { Logger } from "./log.ts";
import type { ChatSink, DialogButton, PostOptions } from "./session.ts";

export interface SlackOptions {
  botToken: string;
  appToken: string;
  log: Logger;
}

export interface SlackHandlers {
  onMessage(ev: InboundEvent): Promise<void>;
  onDialogAction(userId: string, value: string): boolean;
}

type SlackFile = { id?: string; name?: string; title?: string; mimetype?: string; size?: number; url_private_download?: string; url_private?: string };

/** Slack error code from a WebClient error, if any. */
function slackError(e: unknown): string | undefined {
  return (e as { data?: { error?: string } }).data?.error;
}

const SECTION_LIMIT = 2_900;

export class SlackPlatform implements ChatPlatform {
  readonly app: App;
  botUserId = "";
  private readonly opts: SlackOptions;
  private readonly log: Logger;
  private markdownBlocks = true;
  private seen = new Set<string>();
  private names = new Map<string, string>();

  constructor(opts: SlackOptions) {
    this.opts = opts;
    this.log = opts.log.child({ component: "slack" });
    const boltLevel = process.env.LOG_LEVEL === "debug" ? LogLevel.DEBUG : LogLevel.WARN;
    this.app = new App({ token: opts.botToken, appToken: opts.appToken, socketMode: true, logLevel: boltLevel });
  }

  async start(handlers: SlackHandlers): Promise<void> {
    this.app.event("message", async ({ event }) => {
      const e = event as unknown as Record<string, unknown>;
      const subtype = e.subtype as string | undefined;
      if (subtype && subtype !== "file_share" && subtype !== "thread_broadcast") return;
      if (e.bot_id || typeof e.user !== "string" || e.user === this.botUserId) return;
      const channel = String(e.channel);
      const ts = String(e.ts);
      if (this.isDuplicate(`${channel}:${ts}`)) return;
      const files = Array.isArray(e.files) ? (e.files as SlackFile[]) : [];
      const inbound: InboundEvent = {
        userId: e.user,
        channelId: channel,
        channelType: (e.channel_type as InboundEvent["channelType"]) ?? "channel",
        text: typeof e.text === "string" ? e.text : "",
        ts,
        threadTs: typeof e.thread_ts === "string" ? e.thread_ts : undefined,
        files: files.map((f) => ({
          id: f.id ?? "file",
          name: f.name ?? f.title ?? f.id ?? "file",
          mimeType: f.mimetype ?? "application/octet-stream",
          size: f.size ?? 0,
          url: f.url_private_download ?? f.url_private,
        })),
      };
      // Don't hold the Socket Mode ack while pi works.
      void handlers.onMessage(inbound).catch((err: Error) => this.log.error("message handler failed", { error: err }));
    });

    this.app.action<BlockAction<ButtonAction>>(/^piui:/, async ({ ack, body, action, client }) => {
      await ack();
      const ok = handlers.onDialogAction(body.user.id, action.value ?? "");
      if (!ok && body.channel?.id) {
        await client.chat
          .postEphemeral({ channel: body.channel.id, user: body.user.id, text: "That question is no longer pending." })
          .catch(() => undefined);
      }
    });

    this.app.error(async (error) => {
      this.log.error("bolt error", { error });
    });

    await this.app.start();
    const auth = await this.app.client.auth.test();
    this.botUserId = String(auth.user_id ?? "");
    this.log.info("connected to Slack", { team: auth.team, bot: auth.user, botUserId: this.botUserId });
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  private isDuplicate(key: string): boolean {
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    if (this.seen.size > 2_000) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return false;
  }

  async channelName(channelId: string): Promise<string | undefined> {
    const cached = this.names.get(channelId);
    if (cached) return cached;
    const res = await this.app.client.conversations.info({ channel: channelId });
    const name = res.channel?.name;
    if (name) this.names.set(channelId, name);
    return name;
  }

  async downloadFile(file: InboundFile, destPath: string): Promise<void> {
    if (!file.url) throw new Error("file has no download URL");
    const res = await fetch(file.url, { headers: { Authorization: `Bearer ${this.opts.botToken}` } });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    if ((res.headers.get("content-type") ?? "").startsWith("text/html") && !file.mimeType.startsWith("text/html")) {
      throw new Error("Slack returned an HTML page (is the files:read scope granted?)");
    }
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(destPath, { mode: 0o600 }));
  }

  sinkFor(channel: string): ChatSink {
    const client = this.app.client;
    const log = this.log;
    const thread = (opts?: PostOptions) => (opts?.threadTs ? { thread_ts: opts.threadTs } : {});

    const postMarkdown = async (markdown: string, opts?: PostOptions): Promise<string | undefined> => {
      let first: string | undefined;
      for (const chunk of splitMarkdown(markdown)) {
        let ts: string | undefined;
        if (this.markdownBlocks) {
          try {
            const res = await client.chat.postMessage({
              channel,
              text: truncate(chunk, 300),
              blocks: [{ type: "markdown", text: chunk }],
              ...thread(opts),
            });
            ts = res.ts;
          } catch (e) {
            const code = slackError(e);
            if (code !== "invalid_blocks" && code !== "invalid_blocks_format") throw e;
            log.warn("markdown blocks rejected; falling back to plain text", { code });
            this.markdownBlocks = false;
          }
        }
        if (!this.markdownBlocks) {
          const res = await client.chat.postMessage({ channel, text: chunk, ...thread(opts) });
          ts = res.ts;
        }
        first ??= ts;
      }
      return first;
    };

    return {
      postMarkdown,
      postNotice: async (text, opts) => {
        const res = await client.chat.postMessage({ channel, text, ...thread(opts) });
        return res.ts;
      },
      postButtons: async (text: string, buttons: DialogButton[], opts?: PostOptions) => {
        const res = await client.chat.postMessage({
          channel,
          text: truncate(text, 300),
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: text.slice(0, SECTION_LIMIT) } },
            {
              type: "actions",
              elements: buttons.slice(0, 25).map((b, i) => ({
                type: "button" as const,
                action_id: `piui:${i}`,
                text: { type: "plain_text" as const, text: b.label || " " },
                value: b.value,
                ...(b.style ? { style: b.style } : {}),
              })),
            },
          ],
          ...thread(opts),
        });
        return res.ts;
      },
      update: async (ts, text) => {
        await client.chat.update({
          channel,
          ts,
          text: truncate(text, 300),
          blocks: [{ type: "section", text: { type: "mrkdwn", text: text.slice(0, SECTION_LIMIT) } }],
        });
      },
      remove: async (ts) => {
        await client.chat.delete({ channel, ts }).catch((e: unknown) => {
          if (slackError(e) !== "message_not_found") throw e;
        });
      },
      react: async (ts, emoji) => {
        await client.reactions.add({ channel, timestamp: ts, name: emoji }).catch((e: unknown) => {
          if (slackError(e) !== "already_reacted") log.warn("reaction failed", { emoji, error: slackError(e) ?? String(e) });
        });
      },
      unreact: async (ts, emoji) => {
        await client.reactions.remove({ channel, timestamp: ts, name: emoji }).catch((e: unknown) => {
          if (slackError(e) !== "no_reaction") log.warn("unreact failed", { emoji, error: slackError(e) ?? String(e) });
        });
      },
    };
  }
}
