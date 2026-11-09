import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export type NotifyLevel = "all" | "warnings" | "none";

export interface BindingOptions {
  /** Working directory of the pi process for this binding (absolute after loading). */
  cwd: string;
  /** Optional `--model` pattern, e.g. "kumo/deepseek-4.1-flash". Defaults to pi's settings. */
  model?: string;
  /** Optional `--thinking` level. */
  thinking?: string;
  /** Optional session display name (`--name`). */
  name?: string;
}

export interface GatewayConfig {
  /** Slack user IDs allowed to talk to the agent. Everyone else is ignored. */
  allowedUsers: string[];
  /** `!bind <path>` may only target directories inside these roots (absolute). */
  allowedRoots: string[];
  /** Binding used for direct messages (one session per allowed user). */
  dm: BindingOptions;
  /** Static channel bindings keyed by Slack channel ID (C…/G…). */
  channels: Record<string, BindingOptions>;
  pi: {
    command: string;
    /** Extra CLI args appended to every pi invocation. */
    args: string[];
    /** File appended to the system prompt via `--append-system-prompt`, or null to disable. */
    appendSystemPrompt: string | null;
  };
  /** Which extension `notify` UI events are posted to Slack. */
  notify: NotifyLevel;
  /** Post a live "working…" status message once a run lasts longer than this. */
  statusDelayMs: number;
  /** Minimum interval between status message edits. */
  statusIntervalMs: number;
  /** Gateway state (bindings, session pointers, inbox). */
  stateDir: string;
}

export const DEFAULT_PROMPT = resolve(import.meta.dirname, "..", "prompts", "manager.md");

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function absPath(p: string, base = homedir()): string {
  const expanded = expandHome(p.trim());
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

export function isInside(child: string, root: string): boolean {
  const c = resolve(child);
  const r = resolve(root);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function fail(msg: string): never {
  throw new Error(`config: ${msg}`);
}

function binding(raw: unknown, where: string): BindingOptions {
  if (typeof raw === "string") return { cwd: absPath(raw) };
  if (!raw || typeof raw !== "object") fail(`${where} must be a path string or an object with "cwd"`);
  const o = raw as Record<string, unknown>;
  if (typeof o.cwd !== "string" || !o.cwd) fail(`${where}.cwd must be a non-empty string`);
  const out: BindingOptions = { cwd: absPath(o.cwd) };
  for (const key of ["model", "thinking", "name"] as const) {
    const v = o[key];
    if (v === undefined) continue;
    if (typeof v !== "string") fail(`${where}.${key} must be a string`);
    out[key] = v;
  }
  return out;
}

export function defaultConfigPath(): string {
  return process.env.PI_SLACK_GATEWAY_CONFIG ?? join(homedir(), ".config", "pi-slack-gateway", "config.json");
}

export function parseConfig(raw: unknown): GatewayConfig {
  if (!raw || typeof raw !== "object") fail("root must be an object");
  const o = raw as Record<string, unknown>;

  const allowedUsers = o.allowedUsers;
  if (!Array.isArray(allowedUsers) || allowedUsers.length === 0 || !allowedUsers.every((u) => typeof u === "string" && /^[UW][A-Z0-9]+$/.test(u))) {
    fail('"allowedUsers" must be a non-empty array of Slack user IDs (U…)');
  }

  const roots = o.allowedRoots ?? ["~"];
  if (!Array.isArray(roots) || !roots.every((r) => typeof r === "string")) fail('"allowedRoots" must be an array of paths');

  const channels: Record<string, BindingOptions> = {};
  if (o.channels !== undefined) {
    if (!o.channels || typeof o.channels !== "object") fail('"channels" must be an object keyed by channel ID');
    for (const [id, b] of Object.entries(o.channels as Record<string, unknown>)) {
      if (!/^[CG][A-Z0-9]+$/.test(id)) fail(`channels key "${id}" is not a Slack channel ID (C…/G…)`);
      channels[id] = binding(b, `channels.${id}`);
    }
  }

  const pi = (o.pi ?? {}) as Record<string, unknown>;
  const command = pi.command ?? "pi";
  if (typeof command !== "string") fail('"pi.command" must be a string');
  const args = pi.args ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) fail('"pi.args" must be an array of strings');
  let appendSystemPrompt: string | null = DEFAULT_PROMPT;
  if (pi.appendSystemPrompt === null || pi.appendSystemPrompt === false) appendSystemPrompt = null;
  else if (typeof pi.appendSystemPrompt === "string") appendSystemPrompt = absPath(pi.appendSystemPrompt);
  else if (pi.appendSystemPrompt !== undefined) fail('"pi.appendSystemPrompt" must be a path or null');

  const notify = o.notify ?? "warnings";
  if (notify !== "all" && notify !== "warnings" && notify !== "none") fail('"notify" must be "all", "warnings" or "none"');

  const num = (key: string, def: number): number => {
    const v = o[key] ?? def;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) fail(`"${key}" must be a non-negative number`);
    return v;
  };

  const stateDir = typeof o.stateDir === "string"
    ? absPath(o.stateDir)
    : process.env.PI_SLACK_GATEWAY_STATE_DIR
      ? absPath(process.env.PI_SLACK_GATEWAY_STATE_DIR)
      : join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi-slack-gateway");

  return {
    allowedUsers: allowedUsers as string[],
    allowedRoots: (roots as string[]).map((r) => absPath(r)),
    dm: o.dm === undefined ? { cwd: homedir() } : binding(o.dm, "dm"),
    channels,
    pi: { command, args: args as string[], appendSystemPrompt },
    notify,
    statusDelayMs: num("statusDelayMs", 4_000),
    statusIntervalMs: num("statusIntervalMs", 5_000),
    stateDir,
  };
}

export function loadConfig(path = defaultConfigPath()): GatewayConfig {
  if (!existsSync(path)) fail(`${path} not found (copy deploy/config.example.json)`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`${path}: ${(e as Error).message}`);
  }
  const config = parseConfig(raw);
  if (config.pi.appendSystemPrompt && !existsSync(config.pi.appendSystemPrompt)) {
    fail(`pi.appendSystemPrompt file not found: ${config.pi.appendSystemPrompt}`);
  }
  return config;
}
