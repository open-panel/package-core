import { describe, expect, it, vi } from "vitest";
import { Logger, redact } from "./logger.js";

describe("redact", () => {
  it("masks top-level keys that look like secrets", () => {
    expect(redact({ password: "hunter2", user: "bob" })).toEqual({ password: "***", user: "bob" });
  });

  it("masks nested secrets, e.g. inside an env object", () => {
    expect(redact({ env: { API_KEY: "abc", HOME: "/root" } })).toEqual({
      env: { API_KEY: "***", HOME: "/root" },
    });
  });

  it("leaves ordinary metadata untouched", () => {
    expect(redact({ deviceId: "d1", position: 3 })).toEqual({ deviceId: "d1", position: 3 });
  });
});

describe("Logger", () => {
  it("keeps a bounded ring buffer and exposes recent entries", () => {
    const logger = new Logger({ maxBufferSize: 3, write: () => {} });
    for (let i = 0; i < 5; i++) logger.info(`event-${i}`);
    const recent = logger.recent(10);
    expect(recent).toHaveLength(3);
    expect(recent.map((e) => e.event)).toEqual(["event-2", "event-3", "event-4"]);
  });

  it("redacts secrets before they reach the sink/write callback", () => {
    const write = vi.fn();
    const logger = new Logger({ write });
    logger.error("action.failed", { token: "super-secret", actionType: "shell" });
    const written = JSON.parse(write.mock.calls[0]![0] as string);
    expect(written.meta.token).toBe("***");
    expect(written.meta.actionType).toBe("shell");
  });
});
