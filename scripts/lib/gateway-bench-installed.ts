import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { hasErrnoCode } from "../../src/infra/errno.ts";
import { writeJsonAtomic } from "../../src/infra/json-files.ts";
import { stopChild, stopGatewayGracefully } from "./gateway-bench-child.ts";
import { getFreePort } from "./gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  classifyGatewayReadyLog,
  collectOutputLines,
  createGatewayBenchEnv,
  summarizeNumbers,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "./gateway-bench-runtime.ts";
import { createGatewayWsClient } from "./gateway-ws-client.ts";
import { inspectManagedProcessGroup, runManagedCommand } from "./managed-child-process.mts";
import {
  LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
} from "./package-lifecycle-marker.mjs";

const sha = z.string().regex(/^[0-9a-f]{40}$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const inputSchema = z.object({
  sourceSha: sha,
  toolingSha: sha,
  tarball: z.string().min(1),
  candidate: z
    .object({
      name: z.literal("openclaw"),
      packageSourceSha: sha,
      version: z.string().min(1),
      sha256: digest,
    })
    .passthrough(),
  installRoot: z.string().min(1),
  stateRoot: z.string().min(1),
  runtime: z.object({ version: z.string().regex(/^v\d+\.\d+\.\d+$/u), sha256: digest }),
  artifact: z.object({
    id: z.number().int().positive(),
    runId: z.number().int().positive(),
    runAttempt: z.number().int().positive(),
    workflowSha: sha,
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  }),
});

const sampleSchema = z.object({
  index: z.number().int().nonnegative(),
  phase: z.enum(["fresh", "established"]),
  outcome: z.enum(["not-run", "running", "passed", "failed"]),
  observations: z.record(z.string(), z.unknown()),
  errors: z.array(z.string()),
  stdout: z.string(),
  stderr: z.string(),
  readyMs: z.number().nonnegative().optional(),
});
const checkpointSchema = z
  .object({
    outcome: z.enum(["pending", "running", "cohort-passed", "failed"]),
    samples: z.array(sampleSchema).length(9),
  })
  .passthrough();
type Sample = z.infer<typeof sampleSchema>;

const FRESH_TIMEOUT_MS = 180_000;
const RESTART_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 60_000;

function plannedSamples(): Sample[] {
  return Array.from({ length: 9 }, (_, index) => ({
    index,
    phase: index === 0 ? "fresh" : "established",
    outcome: "not-run",
    observations: {},
    errors: [],
    stdout: "",
    stderr: "",
  }));
}

async function hashFile(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function hashInstall(root: string) {
  const hash = createHash("sha256");
  let files = 0;
  async function visit(directory: string) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name, "en"),
    )) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).replaceAll(path.sep, "/");
      if (entry.isSymbolicLink()) {
        hash.update(JSON.stringify([relative, "link", await fs.readlink(full)]) + "\n");
      } else if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        hash.update(JSON.stringify([relative, "file", await hashFile(full)]) + "\n");
        files += 1;
      } else {
        throw new Error(`Unsupported installed entry: ${relative}`);
      }
    }
  }
  await visit(root);
  return { sha256: hash.digest("hex"), files };
}

function observe(sample: Sample, name: string, value: unknown) {
  sample.observations[name] = value;
  console.log(
    `[gateway-startup-observation] ${JSON.stringify({ index: sample.index, phase: sample.phase, name, value })}`,
  );
}

async function firstRequests(port: number, startedAt: number, sample: Sample) {
  const client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
  try {
    await client.waitOpen();
    const hello = await client.request("connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        displayName: "startup-benchmark",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.read"],
      caps: [],
    });
    observe(sample, "hello", hello);
    assert.equal(hello.ok, true, "Gateway connect failed");
    for (const [method, params] of [
      ["status", { includeChannelSummary: false }],
      ["health", { probe: true }],
    ] as const) {
      const requestedAt = performance.now();
      const response = await client.request(method, params);
      observe(sample, method, {
        requestedAtMs: requestedAt - startedAt,
        completedAtMs: performance.now() - startedAt,
        requestMs: performance.now() - requestedAt,
        response,
      });
      assert.equal(response.ok, true, `Gateway ${method} request failed`);
      assert.ok(
        response.payload && typeof response.payload === "object",
        `Gateway ${method} payload missing`,
      );
      if (method === "health") {
        assert.equal(
          "ok" in response.payload && response.payload.ok,
          true,
          "Gateway health response is invalid",
        );
      }
    }
  } finally {
    if (client.ws.readyState !== 3) {
      const closed = new Promise<void>((resolve) => {
        client.ws.once("close", () => resolve());
      });
      const timer = setTimeout(() => client.ws.terminate(), 8_000);
      try {
        client.close();
        await closed;
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

async function runSample(params: {
  sample: Sample;
  entry: string;
  installRoot: string;
  root: string;
  config: string;
}) {
  const { sample } = params;
  const port = await getFreePort();
  const env = createGatewayBenchEnv(params.root, params.config, {
    startupTrace: false,
    caseEnv: {
      USERPROFILE: params.root,
      APPDATA: path.join(params.root, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(params.root, "AppData", "Local"),
      TEMP: path.join(params.root, "temp"),
      TMP: path.join(params.root, "temp"),
      TMPDIR: path.join(params.root, "temp"),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
    },
  });
  const stopPreload = new URL("./gateway-bench-stop-preload.mjs", import.meta.url);
  stopPreload.searchParams.set("parentPid", String(process.pid));
  stopPreload.searchParams.set("entry", params.entry);
  const startedAt = performance.now();
  const child = spawn(
    process.execPath,
    buildGatewayBenchChildArgs(params.entry, port, ["--import", stopPreload.href]),
    { cwd: params.installRoot, env, stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true },
  );
  observe(sample, "launch", {
    controllerPid: process.pid,
    pid: child.pid,
    port,
    stateRoot: params.root,
    startedAt: new Date().toISOString(),
  });
  let exited = false;
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
    exited = true;
  });
  child.once("exit", () => {
    exited = true;
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  const buffers = { stdout: "", stderr: "" };
  for (const stream of ["stdout", "stderr"] as const) {
    const pipe = child[stream];
    assert.ok(pipe, `Gateway ${stream} pipe missing`);
    pipe.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      sample[stream] += text;
      process[stream].write(chunk);
      const parsed = collectOutputLines(buffers[stream], text);
      buffers[stream] = parsed.carry;
      for (const line of parsed.lines) {
        const kind = classifyGatewayReadyLog(line);
        if (kind && sample.observations[kind] === undefined) {
          observe(sample, kind, { ms: performance.now() - startedAt, line });
        }
      }
    });
  }
  try {
    const deadlineAt =
      startedAt + (sample.phase === "fresh" ? FRESH_TIMEOUT_MS : RESTART_TIMEOUT_MS);
    const probe = async (name: "healthz" | "readyz") => {
      const result = await waitForInitialProbe({
        deadlineAt,
        isDone: () => exited,
        path: `/${name}`,
        port,
        startAt: startedAt,
      });
      observe(sample, name, result);
      return result;
    };
    const [healthz, readyz] = await Promise.all([probe("healthz"), probe("readyz")]);
    if (spawnError) {
      throw spawnError;
    }
    assert.equal(healthz.status, 200, "Gateway healthz failed");
    assert.equal(readyz.status, 200, "Gateway readyz failed");
    assert.ok(readyz.ms !== null, "Gateway never became ready");
    sample.readyMs = readyz.ms;
    await firstRequests(port, startedAt, sample);
  } catch (error) {
    sample.errors.push(String(error));
  } finally {
    try {
      assert.equal(exited, false, "Gateway exited before teardown");
      observe(sample, "shutdown", await stopGatewayGracefully(child, STOP_TIMEOUT_MS));
    } catch (error) {
      sample.errors.push(String(error));
      sample.observations.forcedCleanup = await stopChild(child);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Gateway close not observed after forced cleanup")),
              10_000,
            );
          }),
        ]);
      } catch (cleanupError) {
        sample.errors.push(String(cleanupError));
      } finally {
        clearTimeout(timer);
      }
    }
    sample.outcome = sample.errors.length ? "failed" : "passed";
  }
  return sample.outcome;
}

type InstalledOptions = { inputPath: string; outputPath: string; child: boolean; argv: string[] };

export async function runInstalledGatewayBenchmark(options: InstalledOptions): Promise<number> {
  const output = path.resolve(options.outputPath);
  const inputPath = path.resolve(options.inputPath);
  if (!options.child) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    // A retained failed attempt is immutable; callers choose a fresh artifact path.
    await fs.writeFile(
      output,
      JSON.stringify({ outcome: "pending", inputPath, samples: plannedSamples() }),
      { flag: "wx" },
    );
    let beforeCleanup: ReturnType<typeof inspectManagedProcessGroup> | undefined;
    let exitCode: number | undefined;
    let error: string | undefined;
    try {
      exitCode = await runManagedCommand({
        bin: process.execPath,
        args: [...process.execArgv, process.argv[1]!, ...options.argv, "--installed-child"],
        shell: false,
        requireProcessTreeExit: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        timeoutMs: 30 * 60_000,
        onReady(child) {
          child.stdout?.pipe(process.stdout, { end: false });
          child.stderr?.pipe(process.stderr, { end: false });
          child.once("exit", () => {
            beforeCleanup = inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" });
          });
        },
      });
    } catch (failure) {
      error = String(failure);
    }
    const outerSettlement = {
      outcome: "failed",
      beforeCleanup,
      exitCode,
      error,
      joined: exitCode !== undefined,
    };
    await writeJsonAtomic(`${output}.outer.json`, outerSettlement);
    let report: z.infer<typeof checkpointSchema>;
    try {
      report = checkpointSchema.parse(JSON.parse(await fs.readFile(output, "utf8")));
    } catch {
      return 1;
    } // Preserve malformed raw evidence alongside the independent settlement receipt.
    report.outerSettlement = outerSettlement;
    for (const sample of report.samples) {
      if (sample.outcome === "running") {
        sample.outcome = "failed";
        sample.errors.push("Benchmark controller ended before this launched sample settled");
      }
    }
    // Windows normal cleanup may kill lingering Job members and still return zero.
    // Require the pre-cleanup observation as well as the inner acknowledged stop.
    const passed =
      exitCode === 0 &&
      beforeCleanup === "dead" &&
      report.outcome === "cohort-passed" &&
      report.samples.every(
        (sample, index) =>
          sample.index === index &&
          sample.phase === (index === 0 ? "fresh" : "established") &&
          sample.outcome === "passed" &&
          sample.readyMs !== undefined,
      );
    const finalReport = {
      ...report,
      outcome: passed ? "passed" : "failed",
      establishedReadySummary: passed
        ? summarizeNumbers(
            report.samples
              .slice(1)
              .flatMap((sample) => (sample.readyMs === undefined ? [] : [sample.readyMs])),
          )
        : null,
    };
    outerSettlement.outcome = finalReport.outcome;
    await writeJsonAtomic(`${output}.outer.json`, outerSettlement);
    await writeJsonAtomic(output, finalReport);
    return passed ? 0 : 1;
  }

  const input = inputSchema.parse(JSON.parse(await fs.readFile(inputPath, "utf8")));
  assert.equal(process.version, input.runtime.version, "Benchmark runtime changed");
  assert.equal(
    await hashFile(process.execPath),
    input.runtime.sha256,
    "Benchmark executable changed",
  );
  const candidate = input.candidate;
  assert.equal(
    candidate.packageSourceSha,
    input.sourceSha,
    "Package source differs from requested source",
  );
  assert.equal(await hashFile(input.tarball), candidate.sha256, "Package tarball changed");
  const installRoot = await fs.realpath(input.installRoot);
  const packageRoot = path.join(installRoot, "node_modules", "openclaw");
  const entry = path.join(packageRoot, "openclaw.mjs");
  const buildInfo = JSON.parse(
    await fs.readFile(path.join(packageRoot, "dist", "build-info.json"), "utf8"),
  );
  const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(buildInfo.commit, input.sourceSha, "Installed package source changed");
  assert.equal(packageJson.name, "openclaw");
  assert.equal(packageJson.version, candidate.version);
  for (const marker of [
    PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
    LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  ]) {
    assert.equal(
      await fs.lstat(path.join(packageRoot, marker)).then(
        () => true,
        (error: unknown) => {
          if (hasErrnoCode(error, "ENOENT")) {
            return false;
          }
          throw error;
        },
      ),
      false,
      `Installed lifecycle has not settled: ${marker}`,
    );
  }
  const root = path.resolve(input.stateRoot);
  const relativeState = path.relative(installRoot, root);
  assert.ok(
    relativeState === ".." ||
      relativeState.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeState),
    "Synthetic state must be outside the immutable installation",
  );
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, "temp"));
  const config = writeGatewayBenchConfig(root, BASE_GATEWAY_BENCH_CONFIG, {});
  const harnessFiles = [
    process.argv[1]!,
    ...[
      "gateway-bench-installed.ts",
      "gateway-bench-stop-preload.mjs",
      "gateway-bench-child.ts",
      "gateway-bench-runtime.ts",
      "gateway-bench-probes.ts",
      "gateway-ws-client.ts",
      "managed-child-process.mts",
      "managed-windows-job.mts",
      "managed-windows-job-launcher.mts",
    ].map((name) => fileURLToPath(new URL(name, import.meta.url))),
  ];
  const hashHarness = async () =>
    Object.fromEntries(
      await Promise.all(harnessFiles.map(async (file) => [file, await hashFile(file)])),
    );
  const samples = plannedSamples();
  const report = {
    artifactKind: "installed-package",
    outcome: "running",
    input,
    buildInfo,
    runtime: {
      executable: process.execPath,
      version: process.version,
      versions: process.versions,
      sha256: await hashFile(process.execPath),
      platform: process.platform,
      arch: process.arch,
    },
    host: {
      runner: process.env.RUNNER_NAME ?? null,
      image: process.env.ImageOS ?? null,
      imageVersion: process.env.ImageVersion ?? null,
      os: os.release(),
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      totalMemory: os.totalmem(),
    },
    limitations: [
      "Fresh means new synthetic state, not a cold filesystem",
      "One immutable install; first sample is separate from eight retained-state restarts",
      "A dedicated runner is a new baseline, not a causal comparison to desktop measurements",
      "No synchronous process sampling or startup profiling; the stop-only preload is retained",
      "RPC success is recorded separately from plugin availability and degraded diagnostic facts",
    ],
    deadlines: {
      freshMs: FRESH_TIMEOUT_MS,
      restartMs: RESTART_TIMEOUT_MS,
      shutdownMs: STOP_TIMEOUT_MS,
    },
    before: await hashInstall(installRoot),
    harnessHashes: await hashHarness(),
    inputSha256: await hashFile(inputPath),
    after: undefined as Awaited<ReturnType<typeof hashInstall>> | undefined,
    samples,
    errors: [] as string[],
    establishedReadySummary: null as ReturnType<typeof summarizeNumbers>,
  };
  const save = () => writeJsonAtomic(output, report);
  await save();
  try {
    for (const sample of samples) {
      sample.outcome = "running";
      sample.observations.stateRoot = root;
      await save();
      const outcome = await runSample({ sample, entry, installRoot, root, config });
      await save();
      console.log(
        `[gateway-startup-bench] installed ${sample.phase} ${sample.index}: ${sample.outcome} ready=${sample.readyMs ?? "missing"}ms`,
      );
      if (outcome !== "passed") {
        break;
      }
    }
  } catch (error) {
    report.errors.push(String(error));
    for (const sample of samples) {
      if (sample.outcome === "running") {
        sample.errors.push(String(error));
        sample.outcome = "failed";
      }
    }
  } finally {
    try {
      report.after = await hashInstall(installRoot);
      assert.deepEqual(report.after, report.before, "Installed tree changed during measurement");
      assert.equal(
        await hashFile(process.execPath),
        input.runtime.sha256,
        "Runtime changed during measurement",
      );
      assert.equal(
        await hashFile(input.tarball),
        candidate.sha256,
        "Package tarball changed during measurement",
      );
      assert.deepEqual(
        await hashHarness(),
        report.harnessHashes,
        "Benchmark helpers changed during measurement",
      );
      assert.equal(
        await hashFile(inputPath),
        report.inputSha256,
        "Benchmark input changed during measurement",
      );
    } catch (error) {
      report.errors.push(String(error));
    }
    report.outcome =
      !report.errors.length && samples.every((sample) => sample.outcome === "passed")
        ? "cohort-passed"
        : "failed";
    await save();
  }
  return report.outcome === "cohort-passed" ? 0 : 1;
}
