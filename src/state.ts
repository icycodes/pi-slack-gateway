/**
 * Small persistent state (JSON, atomic rename):
 *  - channels bound at runtime with `!bind`
 *  - per-binding pointers: Slack channel to post into + pi session file to resume
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "./log.ts";

export interface SessionPointer {
  /** Slack channel the binding posts into (DM channel for DM bindings). */
  channelId: string;
  /** Last known pi session file; resumed with `--session` on (re)start. */
  sessionFile?: string;
  updatedAt: string;
}

export interface DynamicBinding {
  cwd: string;
  boundBy: string;
  boundAt: string;
}

interface StateFile {
  version: 1;
  channels: Record<string, DynamicBinding>;
  sessions: Record<string, SessionPointer>;
}

export class StateStore {
  readonly path: string;
  private data: StateFile;
  private readonly log: Logger;

  constructor(stateDir: string, log: Logger) {
    this.path = join(stateDir, "state.json");
    this.log = log;
    this.data = this.read();
  }

  private read(): StateFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StateFile>;
      return { version: 1, channels: parsed.channels ?? {}, sessions: parsed.sessions ?? {} };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.log.warn("could not read state, starting empty", { path: this.path, error: e });
      return { version: 1, channels: {}, sessions: {} };
    }
  }

  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  get channels(): Readonly<Record<string, DynamicBinding>> {
    return this.data.channels;
  }

  get sessions(): Readonly<Record<string, SessionPointer>> {
    return this.data.sessions;
  }

  bindChannel(channelId: string, cwd: string, userId: string): void {
    this.data.channels[channelId] = { cwd, boundBy: userId, boundAt: new Date().toISOString() };
    this.write();
  }

  unbindChannel(channelId: string, sessionKey: string): void {
    delete this.data.channels[channelId];
    delete this.data.sessions[sessionKey];
    this.write();
  }

  setSession(key: string, patch: Partial<Omit<SessionPointer, "updatedAt">> & { channelId: string }): void {
    const prev = this.data.sessions[key];
    const next: SessionPointer = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    if (prev && prev.channelId === next.channelId && prev.sessionFile === next.sessionFile) return;
    this.data.sessions[key] = next;
    this.write();
  }
}
