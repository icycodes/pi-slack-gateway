/** Pure formatting helpers (no Slack or pi dependencies, unit-tested). */

/** Slack `markdown` blocks accept 12k chars per payload; keep headroom. */
export const MAX_CHUNK = 11_000;

/**
 * Split markdown into chunks of at most `limit` chars, preferring line boundaries
 * and keeping fenced code blocks balanced across chunks.
 */
export function splitMarkdown(text: string, limit = MAX_CHUNK): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  const closeLen = 4; // "\n```"
  let current: string[] = [];
  let size = 0;
  let added = 0; // lines added since the last flush (excluding a re-opened fence)
  let fence: string | null = null; // opening fence line while inside a code block

  const flush = () => {
    chunks.push(current.join("\n") + (fence ? "\n```" : ""));
    current = fence ? [fence] : [];
    size = fence ? fence.length : 0;
    added = 0;
  };

  // Hard-wrap overlong lines, leaving room for a re-opened fence and its close.
  const budget = Math.max(1, limit - closeLen - 24);
  const pieces: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= budget) pieces.push(line);
    else for (let i = 0; i < line.length; i += budget) pieces.push(line.slice(i, i + budget));
  }

  for (const line of pieces) {
    const extra = (current.length > 0 ? 1 : 0) + line.length;
    if (added > 0 && size + extra + (fence ? closeLen : 0) > limit) flush();
    size += (current.length > 0 ? 1 : 0) + line.length;
    current.push(line);
    added++;
    if (/^\s*```/.test(line)) fence = fence ? null : line.trim().slice(0, 20);
  }
  if (added > 0) chunks.push(current.join("\n"));
  return chunks;
}

/**
 * Convert Slack's wire format for message text into plain text for the model:
 * `<url|label>` links, `<@U…>` mentions, `<#C…|name>` channels, HTML entities.
 */
export function slackToPlain(text: string): string {
  return text
    .replace(/<([^<>]+)>/g, (_m, inner: string) => {
      const [target = "", label] = inner.split("|", 2);
      if (target.startsWith("@")) return label ? `@${label}` : `@${target.slice(1)}`;
      if (target.startsWith("#")) return label ? `#${label}` : `#${target.slice(1)}`;
      if (target.startsWith("!")) return label ?? `@${target.slice(1).replace(/^subteam\^/, "")}`;
      if (target.startsWith("mailto:")) return label ?? target.slice(7);
      return label && label !== target ? `${label} (${target})` : target;
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Inline code that survives Slack mrkdwn (no backticks inside). */
function code(s: string): string {
  return `\`${s.replace(/`/g, "'")}\``;
}

/** Human label for a running tool call, e.g. "bash `npm test`". */
export function describeTool(toolName: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
  switch (toolName) {
    case "bash":
      return str("command") ? `bash ${code(truncate(str("command")!, 80))}` : "bash";
    case "read":
    case "edit":
    case "write":
    case "ls":
      return str("path") ? `${toolName} ${code(truncate(str("path")!, 80))}` : toolName;
    case "grep":
    case "find":
      return str("pattern") ? `${toolName} ${code(truncate(str("pattern")!, 60))}` : toolName;
    case "subagent": {
      const what = str("action") ?? str("agent") ?? (Array.isArray(a.tasks) ? `${a.tasks.length} tasks` : Array.isArray(a.chain) ? "chain" : undefined);
      return what ? `subagent ${code(truncate(what, 60))}` : "subagent";
    }
    default:
      return toolName;
  }
}

// ---------------------------------------------------------------------------
// pi-subagents async status snapshot (sent through the "subagent-async" widget)
// ---------------------------------------------------------------------------

export interface SubagentRun {
  id: string;
  label: string;
  state: string;
  startedAt?: number;
  updatedAt?: number;
}

const SNAPSHOT_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";

/** Parse pi-subagents' machine-readable widget payload. Returns null for other widget content. */
export function parseSubagentSnapshot(lines: readonly string[] | undefined): SubagentRun[] | null {
  const first = lines?.[0];
  if (!first?.startsWith(SNAPSHOT_PREFIX)) return null;
  try {
    const snap = JSON.parse(first.slice(SNAPSHOT_PREFIX.length)) as { runs?: unknown };
    if (!Array.isArray(snap.runs)) return [];
    return snap.runs.flatMap((r): SubagentRun[] => {
      if (!r || typeof r !== "object") return [];
      const o = r as Record<string, unknown>;
      return [{
        id: String(o.id ?? ""),
        label: String(o.label ?? o.kind ?? "subagent"),
        state: String(o.state ?? "unknown"),
        startedAt: typeof o.startedAt === "number" ? o.startedAt : undefined,
        updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : undefined,
      }];
    });
  } catch {
    return null;
  }
}

export function isActiveRun(run: SubagentRun): boolean {
  return run.state === "running" || run.state === "queued" || run.state === "pending" || run.state === "starting";
}

export function describeRuns(runs: readonly SubagentRun[], now = Date.now()): string[] {
  return runs.map((r) => {
    const age = r.startedAt ? ` · ${formatDuration(now - r.startedAt)}` : "";
    return `• ${r.label} — ${r.state}${age} (${code(r.id.slice(0, 8))})`;
  });
}

// ---------------------------------------------------------------------------
// Assistant message helpers
// ---------------------------------------------------------------------------

export interface AssistantLike {
  role: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

export function messageText(message: AssistantLike): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((b): b is { type: "text"; text: string } => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Outbound file directives
// ---------------------------------------------------------------------------

export interface SendFileDirective {
  /** Path as written by the agent (backticks stripped, not yet resolved). */
  path: string;
  caption?: string;
}

/** `[send-file: <path>]` alone on a line, optionally followed by a caption. */
const SEND_FILE_LINE = /^\s*\[send-file:\s*([^\]]*?)\s*\](?:\s*(.*?))?\s*$/;

/**
 * Extract `[send-file: path] optional caption` lines from assistant text and
 * return the text with those lines removed. Lines inside fenced code blocks are
 * left alone so the agent can show the syntax without triggering an upload.
 */
export function parseSendFileDirectives(text: string): { files: SendFileDirective[]; text: string } {
  const files: SendFileDirective[] = [];
  const kept: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = inFence ? null : SEND_FILE_LINE.exec(line);
    const path = m?.[1]?.replace(/^`+|`+$/g, "").trim();
    if (!m || !path) {
      kept.push(line);
      continue;
    }
    const caption = m[2]?.trim();
    files.push(caption ? { path, caption } : { path });
  }
  if (files.length === 0) return { files, text };
  while (kept.length && !kept[0]!.trim()) kept.shift();
  while (kept.length && !kept[kept.length - 1]!.trim()) kept.pop();
  return { files, text: kept.join("\n") };
}
