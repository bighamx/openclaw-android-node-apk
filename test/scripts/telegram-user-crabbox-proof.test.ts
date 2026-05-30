import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readLogTail,
  readTelegramUserProofLogTailBytes,
  waitForLog,
} from "../../scripts/e2e/telegram-user-crabbox-proof.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-proof-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("telegram user Crabbox proof log polling", () => {
  it("rejects loose numeric log tail limits instead of parsing prefixes", () => {
    expect(() =>
      readTelegramUserProofLogTailBytes({
        OPENCLAW_TELEGRAM_USER_PROOF_LOG_TAIL_BYTES: "1e3",
      }),
    ).toThrow("invalid OPENCLAW_TELEGRAM_USER_PROOF_LOG_TAIL_BYTES: 1e3");
    expect(() =>
      readTelegramUserProofLogTailBytes({
        OPENCLAW_TELEGRAM_USER_PROOF_LOG_TAIL_BYTES: "1000bytes",
      }),
    ).toThrow("invalid OPENCLAW_TELEGRAM_USER_PROOF_LOG_TAIL_BYTES: 1000bytes");
    expect(
      readTelegramUserProofLogTailBytes({
        OPENCLAW_TELEGRAM_USER_PROOF_LOG_TAIL_BYTES: "4096",
      }),
    ).toBe(4096);
  });

  it("reads only the requested log tail", () => {
    const logPath = path.join(makeTempDir(), "gateway.log");
    fs.writeFileSync(logPath, `${"old\n".repeat(2000)}ready\n`, "utf8");

    const tail = readLogTail(logPath, 32);

    expect(tail).toContain("ready");
    expect(tail.length).toBeLessThanOrEqual(32);
    expect(tail).not.toContain("old\nold\nold\nold\nold\nold\nold\nold\nold");
  });

  it("honors short reads when a log shrinks during tailing", () => {
    vi.spyOn(fs, "statSync").mockReturnValue({
      isFile: () => true,
      size: 64,
    } as fs.Stats);
    vi.spyOn(fs, "openSync").mockReturnValue(123 as never);
    vi.spyOn(fs, "closeSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readSync").mockImplementation((_fd, buffer) => {
      if (!Buffer.isBuffer(buffer)) {
        throw new Error("expected buffer read");
      }
      buffer.write("ready");
      return 5;
    });

    expect(readLogTail("/tmp/truncated.log", 64)).toBe("ready");
  });

  it("does not reread the full log while waiting for readiness", async () => {
    const logPath = path.join(makeTempDir(), "mock-openai.log");
    fs.writeFileSync(logPath, `${"noise\n".repeat(2000)}mock-openai listening\n`, "utf8");
    const readFileSync = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("full log read");
    });

    await waitForLog(logPath, /mock-openai listening/u, "mock-openai", 100);

    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("reports only a bounded log tail on timeout", async () => {
    const logPath = path.join(makeTempDir(), "gateway.log");
    fs.writeFileSync(logPath, `old-secret\n${"x".repeat(300_000)}recent failure\n`, "utf8");

    let message = "";
    try {
      await waitForLog(logPath, /\[gateway\] ready/u, "gateway", 0);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("recent failure");
    expect(message).not.toContain("old-secret");
  });
});
