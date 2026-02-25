import type { Command } from "commander";
import { formatZonedTimestamp } from "openclaw/plugin-sdk";
import {
  bootstrapMatrixVerification,
  getMatrixRoomKeyBackupStatus,
  getMatrixVerificationStatus,
  restoreMatrixRoomKeyBackup,
  verifyMatrixRecoveryKey,
} from "./matrix/actions/verification.js";
import { setMatrixSdkLogMode } from "./matrix/client/logging.js";

let matrixJsCliExitScheduled = false;

function scheduleMatrixJsCliExit(): void {
  if (matrixJsCliExitScheduled || process.env.VITEST) {
    return;
  }
  matrixJsCliExitScheduled = true;
  // matrix-js-sdk rust crypto can leave background async work alive after command completion.
  setTimeout(() => {
    process.exit(process.exitCode ?? 0);
  }, 0);
}

function markCliFailure(): void {
  process.exitCode = 1;
}

function formatLocalTimestamp(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return value;
  }
  return formatZonedTimestamp(parsed, { displaySeconds: true }) ?? value;
}

function printTimestamp(label: string, value: string | null | undefined): void {
  const formatted = formatLocalTimestamp(value);
  if (formatted) {
    console.log(`${label}: ${formatted}`);
  }
}

function configureCliLogMode(verbose: boolean): void {
  setMatrixSdkLogMode(verbose ? "default" : "quiet");
}

type MatrixCliBackupStatus = {
  serverVersion: string | null;
  activeVersion: string | null;
  trusted: boolean | null;
  matchesDecryptionKey: boolean | null;
  decryptionKeyCached: boolean | null;
};

type MatrixCliVerificationStatus = {
  encryptionEnabled: boolean;
  verified: boolean;
  userId: string | null;
  deviceId: string | null;
  backupVersion: string | null;
  backup?: MatrixCliBackupStatus;
  recoveryKeyStored: boolean;
  recoveryKeyCreatedAt: string | null;
  pendingVerifications: number;
};

function resolveBackupStatus(status: {
  backupVersion: string | null;
  backup?: MatrixCliBackupStatus;
}): MatrixCliBackupStatus {
  return {
    serverVersion: status.backup?.serverVersion ?? status.backupVersion ?? null,
    activeVersion: status.backup?.activeVersion ?? null,
    trusted: status.backup?.trusted ?? null,
    matchesDecryptionKey: status.backup?.matchesDecryptionKey ?? null,
    decryptionKeyCached: status.backup?.decryptionKeyCached ?? null,
  };
}

function yesNoUnknown(value: boolean | null): string {
  if (value === true) {
    return "yes";
  }
  if (value === false) {
    return "no";
  }
  return "unknown";
}

function printBackupStatus(backup: MatrixCliBackupStatus): void {
  console.log(`Backup server version: ${backup.serverVersion ?? "none"}`);
  console.log(`Backup active on this device: ${backup.activeVersion ?? "no"}`);
  console.log(`Backup trusted by this device: ${yesNoUnknown(backup.trusted)}`);
  console.log(`Backup matches local decryption key: ${yesNoUnknown(backup.matchesDecryptionKey)}`);
  console.log(`Backup key cached locally: ${yesNoUnknown(backup.decryptionKeyCached)}`);
}

function summarizeBackupHealth(backup: MatrixCliBackupStatus): string {
  if (!backup.serverVersion) {
    return "missing on server";
  }
  if (backup.trusted === false || backup.matchesDecryptionKey === false) {
    return "present but not trusted on this device";
  }
  if (!backup.activeVersion) {
    return "present on server but inactive on this device";
  }
  return "active and trusted on this device";
}

function printBackupSummary(backup: MatrixCliBackupStatus): void {
  console.log(`Backup: ${summarizeBackupHealth(backup)}`);
  if (backup.serverVersion) {
    console.log(`Backup version: ${backup.serverVersion}`);
  }
}

function buildVerificationGuidance(status: MatrixCliVerificationStatus): string[] {
  const backup = resolveBackupStatus(status);
  const nextSteps = new Set<string>();
  if (!status.verified) {
    nextSteps.add("Run 'openclaw matrix-js verify device <key>' to verify this device.");
  }
  if (!backup.serverVersion) {
    nextSteps.add("Run 'openclaw matrix-js verify bootstrap' to create a room key backup.");
  } else if (backup.trusted === false || backup.matchesDecryptionKey === false) {
    nextSteps.add(
      "Backup is present but not trusted for this device. Re-run 'openclaw matrix-js verify device <key>'.",
    );
  } else if (!backup.activeVersion) {
    if (status.recoveryKeyStored) {
      nextSteps.add(
        "Run 'openclaw matrix-js verify backup restore' to load the backup key and restore old room keys.",
      );
    } else {
      nextSteps.add(
        "Store a recovery key with 'openclaw matrix-js verify device <key>', then run 'openclaw matrix-js verify backup restore'.",
      );
    }
  }
  if (status.pendingVerifications > 0) {
    nextSteps.add(`Complete ${status.pendingVerifications} pending verification request(s).`);
  }
  return Array.from(nextSteps);
}

function printGuidance(lines: string[]): void {
  if (lines.length === 0) {
    return;
  }
  console.log("Next steps:");
  for (const line of lines) {
    console.log(`- ${line}`);
  }
}

function printVerificationStatus(status: MatrixCliVerificationStatus, verbose = false): void {
  const backup = resolveBackupStatus(status);
  console.log(`Verified: ${status.verified ? "yes" : "no"}`);
  printBackupSummary(backup);
  if (verbose) {
    console.log("Diagnostics:");
    console.log(`User: ${status.userId ?? "unknown"}`);
    console.log(`Device: ${status.deviceId ?? "unknown"}`);
    printBackupStatus(backup);
    console.log(`Recovery key stored: ${status.recoveryKeyStored ? "yes" : "no"}`);
    printTimestamp("Recovery key created at", status.recoveryKeyCreatedAt);
    console.log(`Pending verifications: ${status.pendingVerifications}`);
  } else {
    console.log(`Recovery key stored: ${status.recoveryKeyStored ? "yes" : "no"}`);
  }
  printGuidance(buildVerificationGuidance(status));
}

export function registerMatrixJsCli(params: { program: Command }): void {
  const root = params.program
    .command("matrix-js")
    .description("Matrix-js channel utilities")
    .addHelpText("after", () => "\nDocs: https://docs.openclaw.ai/channels/matrix-js\n");

  const verify = root.command("verify").description("Device verification for Matrix E2EE");

  verify
    .command("status")
    .description("Check Matrix-js device verification status")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--include-recovery-key", "Include stored recovery key in output")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        account?: string;
        verbose?: boolean;
        includeRecoveryKey?: boolean;
        json?: boolean;
      }) => {
        configureCliLogMode(options.verbose === true);
        try {
          const status = await getMatrixVerificationStatus({
            accountId: options.account,
            includeRecoveryKey: options.includeRecoveryKey === true,
          });
          if (options.json) {
            console.log(JSON.stringify(status, null, 2));
            return;
          }
          printVerificationStatus(status, options.verbose === true);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (options.json) {
            console.log(JSON.stringify({ error: message }, null, 2));
          } else {
            console.error(`Error: ${message}`);
          }
          markCliFailure();
        } finally {
          scheduleMatrixJsCliExit();
        }
      },
    );

  const backup = verify.command("backup").description("Matrix room-key backup health and restore");

  backup
    .command("status")
    .description("Show Matrix room-key backup status for this device")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (options: { account?: string; verbose?: boolean; json?: boolean }) => {
      configureCliLogMode(options.verbose === true);
      try {
        const status = await getMatrixRoomKeyBackupStatus({ accountId: options.account });
        if (options.json) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }
        printBackupSummary(status);
        if (options.verbose === true) {
          printBackupStatus(status);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (options.json) {
          console.log(JSON.stringify({ error: message }, null, 2));
        } else {
          console.error(`Backup status failed: ${message}`);
        }
        markCliFailure();
      } finally {
        scheduleMatrixJsCliExit();
      }
    });

  backup
    .command("restore")
    .description("Restore encrypted room keys from server backup")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--recovery-key <key>", "Optional recovery key to load before restoring")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        account?: string;
        recoveryKey?: string;
        verbose?: boolean;
        json?: boolean;
      }) => {
        configureCliLogMode(options.verbose === true);
        try {
          const result = await restoreMatrixRoomKeyBackup({
            accountId: options.account,
            recoveryKey: options.recoveryKey,
          });
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
            if (!result.success) {
              markCliFailure();
            }
            return;
          }
          console.log(`Restore success: ${result.success ? "yes" : "no"}`);
          if (result.error) {
            console.log(`Error: ${result.error}`);
          }
          console.log(`Backup version: ${result.backupVersion ?? "none"}`);
          console.log(`Imported keys: ${result.imported}/${result.total}`);
          printBackupSummary(result.backup);
          if (options.verbose === true) {
            console.log(
              `Loaded key from secret storage: ${result.loadedFromSecretStorage ? "yes" : "no"}`,
            );
            printTimestamp("Restored at", result.restoredAt);
            printBackupStatus(result.backup);
          }
          if (!result.success) {
            markCliFailure();
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (options.json) {
            console.log(JSON.stringify({ success: false, error: message }, null, 2));
          } else {
            console.error(`Backup restore failed: ${message}`);
          }
          markCliFailure();
        } finally {
          scheduleMatrixJsCliExit();
        }
      },
    );

  verify
    .command("bootstrap")
    .description("Bootstrap Matrix-js cross-signing and device verification state")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--recovery-key <key>", "Recovery key to apply before bootstrap")
    .option("--force-reset-cross-signing", "Force reset cross-signing identity before bootstrap")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        account?: string;
        recoveryKey?: string;
        forceResetCrossSigning?: boolean;
        verbose?: boolean;
        json?: boolean;
      }) => {
        configureCliLogMode(options.verbose === true);
        try {
          const result = await bootstrapMatrixVerification({
            accountId: options.account,
            recoveryKey: options.recoveryKey,
            forceResetCrossSigning: options.forceResetCrossSigning === true,
          });
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
            if (!result.success) {
              markCliFailure();
            }
            return;
          }
          console.log(`Bootstrap success: ${result.success ? "yes" : "no"}`);
          if (result.error) {
            console.log(`Error: ${result.error}`);
          }
          console.log(`Verified: ${result.verification.verified ? "yes" : "no"}`);
          console.log(`User: ${result.verification.userId ?? "unknown"}`);
          console.log(`Device: ${result.verification.deviceId ?? "unknown"}`);
          if (options.verbose === true) {
            console.log(
              `Cross-signing published: ${result.crossSigning.published ? "yes" : "no"} (master=${result.crossSigning.masterKeyPublished ? "yes" : "no"}, self=${result.crossSigning.selfSigningKeyPublished ? "yes" : "no"}, user=${result.crossSigning.userSigningKeyPublished ? "yes" : "no"})`,
            );
            printBackupStatus(resolveBackupStatus(result.verification));
            printTimestamp("Recovery key created at", result.verification.recoveryKeyCreatedAt);
            console.log(`Pending verifications: ${result.pendingVerifications}`);
          } else {
            console.log(`Cross-signing published: ${result.crossSigning.published ? "yes" : "no"}`);
            printBackupSummary(resolveBackupStatus(result.verification));
          }
          printGuidance(
            buildVerificationGuidance({
              ...result.verification,
              pendingVerifications: result.pendingVerifications,
            }),
          );
          if (!result.success) {
            markCliFailure();
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (options.json) {
            console.log(JSON.stringify({ success: false, error: message }, null, 2));
          } else {
            console.error(`Verification bootstrap failed: ${message}`);
          }
          markCliFailure();
        } finally {
          scheduleMatrixJsCliExit();
        }
      },
    );

  verify
    .command("device <key>")
    .description("Verify device using a Matrix recovery key")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (key: string, options: { account?: string; verbose?: boolean; json?: boolean }) => {
        configureCliLogMode(options.verbose === true);
        try {
          const result = await verifyMatrixRecoveryKey(key, { accountId: options.account });
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
            if (!result.success) {
              markCliFailure();
            }
          } else if (result.success) {
            console.log("Device verification completed successfully.");
            console.log(`User: ${result.userId ?? "unknown"}`);
            console.log(`Device: ${result.deviceId ?? "unknown"}`);
            printBackupSummary(resolveBackupStatus(result));
            if (options.verbose === true) {
              printBackupStatus(resolveBackupStatus(result));
              printTimestamp("Recovery key created at", result.recoveryKeyCreatedAt);
              printTimestamp("Verified at", result.verifiedAt);
            }
            printGuidance(
              buildVerificationGuidance({
                ...result,
                pendingVerifications: 0,
              }),
            );
          } else {
            console.error(`Verification failed: ${result.error ?? "unknown error"}`);
            markCliFailure();
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (options.json) {
            console.log(JSON.stringify({ success: false, error: message }, null, 2));
          } else {
            console.error(`Verification failed: ${message}`);
          }
          markCliFailure();
        } finally {
          scheduleMatrixJsCliExit();
        }
      },
    );
}
