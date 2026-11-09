/** Minimal structured logger: one JSON object per line on stderr (journald-friendly). */

type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level | undefined) ?? "info"] ?? order.info;

export type Fields = Record<string, unknown>;

function write(level: Level, msg: string, fields?: Fields): void {
  if (order[level] < threshold) return;
  const record: Fields = { t: new Date().toISOString(), level, msg, ...fields };
  for (const [k, v] of Object.entries(record)) {
    if (v instanceof Error) record[k] = { message: v.message, stack: v.stack };
  }
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

export function createLogger(base: Fields = {}): Logger {
  return {
    debug: (msg, f) => write("debug", msg, { ...base, ...f }),
    info: (msg, f) => write("info", msg, { ...base, ...f }),
    warn: (msg, f) => write("warn", msg, { ...base, ...f }),
    error: (msg, f) => write("error", msg, { ...base, ...f }),
    child: (f) => createLogger({ ...base, ...f }),
  };
}

export const log = createLogger();
