import { Command } from "commander";
import { formatZonedTimestamp } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bootstrapMatrixVerificationMock = vi.fn();
const getMatrixRoomKeyBackupStatusMock = vi.fn();
const getMatrixVerificationStatusMock = vi.fn();
const restoreMatrixRoomKeyBackupMock = vi.fn();
const setMatrixSdkLogModeMock = vi.fn();
const verifyMatrixRecoveryKeyMock = vi.fn();

vi.mock("./matrix/actions/verification.js", () => ({
  bootstrapMatrixVerification: (...args: unknown[]) => bootstrapMatrixVerificationMock(...args),
  getMatrixRoomKeyBackupStatus: (...args: unknown[]) => getMatrixRoomKeyBackupStatusMock(...args),
  getMatrixVerificationStatus: (...args: unknown[]) => getMatrixVerificationStatusMock(...args),
  restoreMatrixRoomKeyBackup: (...args: unknown[]) => restoreMatrixRoomKeyBackupMock(...args),
  verifyMatrixRecoveryKey: (...args: unknown[]) => verifyMatrixRecoveryKeyMock(...args),
}));

vi.mock("./matrix/client/logging.js", () => ({
  setMatrixSdkLogMode: (...args: unknown[]) => setMatrixSdkLogModeMock(...args),
}));

let registerMatrixJsCli: typeof import("./cli.js").registerMatrixJsCli;

function buildProgram(): Command {
  const program = new Command();
  registerMatrixJsCli({ program });
  return program;
}

function formatExpectedLocalTimestamp(value: string): string {
  return formatZonedTimestamp(new Date(value), { displaySeconds: true }) ?? value;
}

describe("matrix-js CLI verification commands", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    process.exitCode = undefined;
    ({ registerMatrixJsCli } = await import("./cli.js"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("sets non-zero exit code for device verification failures in JSON mode", async () => {
    verifyMatrixRecoveryKeyMock.mockResolvedValue({
      success: false,
      error: "invalid key",
    });
    const program = buildProgram();

    await program.parseAsync(["matrix-js", "verify", "device", "bad-key", "--json"], {
      from: "user",
    });

    expect(process.exitCode).toBe(1);
  });

  it("sets non-zero exit code for bootstrap failures in JSON mode", async () => {
    bootstrapMatrixVerificationMock.mockResolvedValue({
      success: false,
      error: "bootstrap failed",
      verification: {},
      crossSigning: {},
      pendingVerifications: 0,
      cryptoBootstrap: null,
    });
    const program = buildProgram();

    await program.parseAsync(["matrix-js", "verify", "bootstrap", "--json"], { from: "user" });

    expect(process.exitCode).toBe(1);
  });

  it("sets non-zero exit code for backup restore failures in JSON mode", async () => {
    restoreMatrixRoomKeyBackupMock.mockResolvedValue({
      success: false,
      error: "missing backup key",
      backupVersion: null,
      imported: 0,
      total: 0,
      loadedFromSecretStorage: false,
      backup: {
        serverVersion: "1",
        activeVersion: null,
        trusted: true,
        matchesDecryptionKey: false,
        decryptionKeyCached: false,
      },
    });
    const program = buildProgram();

    await program.parseAsync(["matrix-js", "verify", "backup", "restore", "--json"], {
      from: "user",
    });

    expect(process.exitCode).toBe(1);
  });

  it("keeps zero exit code for successful bootstrap in JSON mode", async () => {
    process.exitCode = 0;
    bootstrapMatrixVerificationMock.mockResolvedValue({
      success: true,
      verification: {},
      crossSigning: {},
      pendingVerifications: 0,
      cryptoBootstrap: {},
    });
    const program = buildProgram();

    await program.parseAsync(["matrix-js", "verify", "bootstrap", "--json"], { from: "user" });

    expect(process.exitCode).toBe(0);
  });

  it("prints local timezone timestamps for verify status output in verbose mode", async () => {
    const recoveryCreatedAt = "2026-02-25T20:10:11.000Z";
    getMatrixVerificationStatusMock.mockResolvedValue({
      encryptionEnabled: true,
      verified: true,
      userId: "@bot:example.org",
      deviceId: "DEVICE123",
      backupVersion: "1",
      backup: {
        serverVersion: "1",
        activeVersion: "1",
        trusted: true,
        matchesDecryptionKey: true,
        decryptionKeyCached: true,
      },
      recoveryKeyStored: true,
      recoveryKeyCreatedAt: recoveryCreatedAt,
      pendingVerifications: 0,
    });
    const program = buildProgram();

    await program.parseAsync(["matrix-js", "verify", "status", "--verbose"], { from: "user" });

    expect(console.log).toHaveBeenCalledWith(
      `Recovery key created at: ${formatExpectedLocalTimestamp(recoveryCreatedAt)}`,
    );
    expect(console.log).toHaveBeenCalledWith("Diagnostics:");
    expect(setMatrixSdkLogModeMock).toHaveBeenCalledWith("default");
  });

  it("prints local timezone timestamps for verify bootstrap and device output in verbose mode", async () => {
    const recoveryCreatedAt = "2026-02-25T20:10:11.000Z";
    const verifiedAt = "2026-02-25T20:14:00.000Z";
    bootstrapMatrixVerificationMock.mockResolvedValue({
      success: true,
      verification: {
        encryptionEnabled: true,
        verified: true,
        userId: "@bot:example.org",
        deviceId: "DEVICE123",
        backupVersion: "1",
        backup: {
          serverVersion: "1",
          activeVersion: "1",
          trusted: true,
          matchesDecryptionKey: true,
          decryptionKeyCached: true,
        },
        recoveryKeyStored: true,
        recoveryKeyId: "SSSS",
        recoveryKeyCreatedAt: recoveryCreatedAt,
        localVerified: true,
        crossSigningVerified: true,
        signedByOwner: true,
      },
      crossSigning: {
        published: true,
        masterKeyPublished: true,
        selfSigningKeyPublished: true,
        userSigningKeyPublished: true,
      },
      pendingVerifications: 0,
      cryptoBootstrap: {},
    });
    verifyMatrixRecoveryKeyMock.mockResolvedValue({
      success: true,
      encryptionEnabled: true,
      userId: "@bot:example.org",
      deviceId: "DEVICE123",
      backupVersion: "1",
      backup: {
        serverVersion: "1",
        activeVersion: "1",
        trusted: true,
        matchesDecryptionKey: true,
        decryptionKeyCached: true,
      },
      verified: true,
      localVerified: true,
      crossSigningVerified: true,
      signedByOwner: true,
      recoveryKeyStored: true,
      recoveryKeyId: "SSSS",
      recoveryKeyCreatedAt: recoveryCreatedAt,
      verifiedAt,
    });
    const program = buildProgram();

    await program.parseAsync(["matrix-js", "verify", "bootstrap", "--verbose"], {
      from: "user",
    });
    await program.parseAsync(["matrix-js", "verify", "device", "valid-key", "--verbose"], {
      from: "user",
    });

    expect(console.log).toHaveBeenCalledWith(
      `Recovery key created at: ${formatExpectedLocalTimestamp(recoveryCreatedAt)}`,
    );
    expect(console.log).toHaveBeenCalledWith(
      `Verified at: ${formatExpectedLocalTimestamp(verifiedAt)}`,
    );
  });

  it("keeps default output concise when verbose is not provided", async () => {
    const recoveryCreatedAt = "2026-02-25T20:10:11.000Z";
    getMatrixVerificationStatusMock.mockResolvedValue({
      encryptionEnabled: true,
      verified: true,
      userId: "@bot:example.org",
      deviceId: "DEVICE123",
      backupVersion: "1",
      backup: {
        serverVersion: "1",
        activeVersion: "1",
        trusted: true,
        matchesDecryptionKey: true,
        decryptionKeyCached: true,
      },
      recoveryKeyStored: true,
      recoveryKeyCreatedAt: recoveryCreatedAt,
      pendingVerifications: 0,
    });
    const program = buildProgram();

    await program.parseAsync(["matrix-js", "verify", "status"], { from: "user" });

    expect(console.log).not.toHaveBeenCalledWith(
      `Recovery key created at: ${formatExpectedLocalTimestamp(recoveryCreatedAt)}`,
    );
    expect(console.log).not.toHaveBeenCalledWith("Pending verifications: 0");
    expect(console.log).not.toHaveBeenCalledWith("Diagnostics:");
    expect(console.log).toHaveBeenCalledWith("Backup: active and trusted on this device");
    expect(setMatrixSdkLogModeMock).toHaveBeenCalledWith("quiet");
  });

  it("prints backup health lines for verify backup status in verbose mode", async () => {
    getMatrixRoomKeyBackupStatusMock.mockResolvedValue({
      serverVersion: "2",
      activeVersion: null,
      trusted: true,
      matchesDecryptionKey: false,
      decryptionKeyCached: false,
    });
    const program = buildProgram();

    await program.parseAsync(["matrix-js", "verify", "backup", "status", "--verbose"], {
      from: "user",
    });

    expect(console.log).toHaveBeenCalledWith("Backup server version: 2");
    expect(console.log).toHaveBeenCalledWith("Backup active on this device: no");
    expect(console.log).toHaveBeenCalledWith("Backup trusted by this device: yes");
  });
});
