import type { LogEntry, LogLevel } from "@open-panel/shared";

export interface LoggerOptions {
  maxBufferSize?: number;
  /** Called for every entry, e.g. to forward it over IPC (specs.md #20). */
  sink?: (entry: LogEntry) => void;
  /** Defaults to console.log(JSON). Overridable for tests. */
  write?: (line: string) => void;
}

const SECRET_KEY_PATTERN = /pass(word)?|token|secret|api[-_]?key|authorization|credential/i;
const REDACTED = "***";

/**
 * Never log secrets, API keys, tokens or passwords (specs.md #18, #20).
 * Redaction is key-name based and recursive so nested metadata (e.g. an
 * "env" object copied from a shell action) is sanitized too.
 */
export function redact(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redact(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Structured logger with a bounded in-memory ring buffer, used both for
 * console/file output and to serve the "Logs/debug screen" (specs.md #3, #20)
 * over IPC without a separate logging backend.
 */
export class Logger {
  private readonly buffer: LogEntry[] = [];
  private readonly maxBufferSize: number;
  private sink: LoggerOptions["sink"];

  constructor(private readonly options: LoggerOptions = {}) {
    this.maxBufferSize = options.maxBufferSize ?? 1000;
    this.sink = options.sink;
  }

  /** Attaches a sink after construction — useful when the sink (e.g. IPC broadcast) is built after the logger. */
  setSink(sink: LoggerOptions["sink"]): void {
    this.sink = sink;
  }

  log(level: LogLevel, event: string, meta?: Record<string, unknown>): void {
    const entry: LogEntry = {
      level,
      event,
      timestamp: Date.now(),
      meta: meta ? redact(meta) : undefined,
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.maxBufferSize) this.buffer.shift();
    this.sink?.(entry);
    (this.options.write ?? defaultWrite)(JSON.stringify(entry));
  }

  trace(event: string, meta?: Record<string, unknown>): void {
    this.log("trace", event, meta);
  }
  debug(event: string, meta?: Record<string, unknown>): void {
    this.log("debug", event, meta);
  }
  info(event: string, meta?: Record<string, unknown>): void {
    this.log("info", event, meta);
  }
  warn(event: string, meta?: Record<string, unknown>): void {
    this.log("warn", event, meta);
  }
  error(event: string, meta?: Record<string, unknown>): void {
    this.log("error", event, meta);
  }

  recent(limit = 200): LogEntry[] {
    return this.buffer.slice(-limit);
  }
}

function defaultWrite(line: string): void {
  console.log(line);
}
