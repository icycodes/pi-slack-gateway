/**
 * Client for one `pi --mode rpc` child process.
 *
 * Protocol (see pi docs/rpc.md): JSONL on stdin/stdout, split strictly on LF
 * (never Node readline, which also splits on U+2028/U+2029). Commands carry an
 * optional `id`; the matching `{"type":"response"}` repeats it. Everything else
 * on stdout is a session event or an `extension_ui_request`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Logger } from "./log.ts";

export type RpcRecord = { type: string; [key: string]: unknown };

export interface RpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface PiRpcOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: Logger;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

/** Splits a byte stream into LF-terminated records. LF (0x0A) never occurs inside a UTF-8 multibyte sequence. */
export class LineSplitter {
  private buffered: Buffer[] = [];

  push(chunk: Buffer, onLine: (line: string) => void): void {
    let start = 0;
    for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, start)) {
      this.buffered.push(chunk.subarray(start, i));
      let line = Buffer.concat(this.buffered).toString("utf8");
      this.buffered = [];
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
      start = i + 1;
    }
    if (start < chunk.length) this.buffered.push(chunk.subarray(start));
  }
}

export class PiRpc extends EventEmitter<{
  event: [RpcRecord];
  exit: [code: number | null, signal: NodeJS.Signals | null];
  stderr: [line: string];
}> {
  private child?: ChildProcess;
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private exited = false;
  private readonly opts: PiRpcOptions;

  constructor(opts: PiRpcOptions) {
    super();
    this.opts = opts;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get alive(): boolean {
    return this.child !== undefined && !this.exited;
  }

  start(): void {
    const { command, args, cwd, env, log } = this.opts;
    log.info("spawning pi", { command, args, cwd });
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;

    const out = new LineSplitter();
    child.stdout!.on("data", (chunk: Buffer) => out.push(chunk, (line) => this.onLine(line)));
    const err = new LineSplitter();
    child.stderr!.on("data", (chunk: Buffer) => err.push(chunk, (line) => this.emit("stderr", line)));
    child.stdin!.on("error", (e) => log.warn("pi stdin error", { error: e }));

    child.on("error", (e) => {
      log.error("pi process error", { error: e });
      this.handleExit(null, null);
    });
    // "close" (not "exit") so every buffered stdout record is delivered first.
    child.on("close", (code, signal) => this.handleExit(code, signal));
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(`pi exited before responding (code=${code} signal=${signal})`));
      this.pending.delete(id);
    }
    this.emit("exit", code, signal);
  }

  private onLine(line: string): void {
    let record: RpcRecord;
    try {
      record = JSON.parse(line) as RpcRecord;
    } catch {
      this.opts.log.warn("non-JSON line on pi stdout", { line: line.slice(0, 500) });
      return;
    }
    if (record.type === "response") {
      const res = record as unknown as RpcResponse;
      const p = res.id !== undefined ? this.pending.get(res.id) : undefined;
      if (p && res.id !== undefined) {
        this.pending.delete(res.id);
        if (p.timer) clearTimeout(p.timer);
        if (res.success) p.resolve(res.data);
        else p.reject(new Error(res.error ?? `${res.command} failed`));
        return;
      }
      if (!res.success) this.opts.log.warn("uncorrelated pi error response", { response: res });
      return;
    }
    this.emit("event", record);
  }

  /** Write one raw record (e.g. an extension_ui_response). */
  send(record: Record<string, unknown>): void {
    if (!this.alive) throw new Error("pi is not running");
    this.child!.stdin!.write(`${JSON.stringify(record)}\n`);
  }

  /** Send a command and resolve with its `data` (rejects on success:false, exit, or timeout). */
  request<T = unknown>(command: Record<string, unknown> & { type: string }, timeoutMs = 60_000): Promise<T> {
    if (!this.alive) return Promise.reject(new Error("pi is not running"));
    const id = `gw-${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { resolve: resolve as (d: unknown) => void, reject };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`pi did not answer ${command.type} within ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      try {
        this.send({ ...command, id });
      } catch (e) {
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(e as Error);
      }
    });
  }

  /** Close stdin (orderly shutdown), escalate to SIGTERM/SIGKILL if pi does not exit in time. */
  async stop(graceMs = 5_000): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    const exited = new Promise<void>((resolve) => this.once("exit", () => resolve()));
    child.stdin!.end();
    const wait = (ms: number) => new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref());
    if (await Promise.race([exited.then(() => true), wait(graceMs)])) return;
    child.kill("SIGTERM");
    if (await Promise.race([exited.then(() => true), wait(2_000)])) return;
    child.kill("SIGKILL");
    await exited;
  }
}
