import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  buildCase,
  canaryTask,
  DEFAULT_SEED,
  generateSuite,
  LIFECYCLE_NAMES,
} from "./generate.mjs";
import { assessCanary, errorRecord, isInformationalFinding } from "./oracles.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function help() {
  console.log(`Offline instruction-scheduling differential harness

  node run.mjs [options]

  --mode short|exhaustive       Default short; exhaustive enumerates all two-region schedules
  --binding PATH                Built native loader (default ../../index.js)
  --output DIRECTORY            Write summary, per-case JSONL, and reproductions here
  --seed INTEGER                Deterministic uint32 seed (default 0x${DEFAULT_SEED.toString(16)})
  --three-region-limit INTEGER  Selected schedules per three-region family (default 256)
  --lifecycle LIST              Optional state,strict,remount,suspense or all
  --jobs INTEGER                Isolated worker processes (default 2, maximum 16)
  --timeout-ms INTEGER          Hard whole-case timeout, all variants/lifecycle (default 30000)
  --run-timeout-ms INTEGER      Hard whole-run timeout (default 900000)
  --filter TEXT                 Select task IDs containing TEXT
  --case ID                     Select an exact task ID (repeatable)
  --repro FILE                  Run the exact task saved in repro.json
  --source-only                 Validate source/oracles using React; no binding or scheduler evidence
  --no-memo                     Also require and run unscheduled/scheduled no-memo transforms
  --require-optional-goals      Fail on optional optimization misses as well
  --list                       Print selected tasks and planned counts without executing
  --help                       Show this help

This program never installs packages, fetches code, or runs Cargo.`);
}

function optionsFromArgs() {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "short" },
      binding: { type: "string" },
      output: { type: "string" },
      seed: { type: "string", default: String(DEFAULT_SEED) },
      "three-region-limit": { type: "string", default: "256" },
      lifecycle: { type: "string", default: "" },
      jobs: { type: "string", default: "2" },
      "timeout-ms": { type: "string", default: "30000" },
      "run-timeout-ms": { type: "string", default: "900000" },
      filter: { type: "string" },
      case: { type: "string", multiple: true },
      repro: { type: "string" },
      "source-only": { type: "boolean", default: false },
      "no-memo": { type: "boolean", default: false },
      "require-optional-goals": { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    help();
    return null;
  }
  const integer = (name, minimum, maximum = Number.MAX_SAFE_INTEGER) => {
    const value = Number(values[name]);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw new Error(`--${name} must be an integer in [${minimum}, ${maximum}]`);
    return value;
  };
  const lifecycle =
    values.lifecycle === "all"
      ? Object.keys(LIFECYCLE_NAMES)
      : values.lifecycle.split(",").filter(Boolean);
  return {
    mode: values.mode,
    seed: integer("seed", 0, 0xffffffff),
    threeRegionLimit: integer("three-region-limit", 1, 2520),
    lifecycle: [...new Set(lifecycle)],
    jobs: integer("jobs", 1, 16),
    timeoutMs: integer("timeout-ms", 100),
    runTimeoutMs: integer("run-timeout-ms", 100),
    binding: path.resolve(values.binding ?? path.join(directory, "../../index.js")),
    output: path.resolve(
      values.output ??
        path.join(
          directory,
          "results",
          `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`,
        ),
    ),
    filter: values.filter,
    cases: values.case,
    repro: values.repro ? path.resolve(values.repro) : null,
    sourceOnly: values["source-only"],
    noMemo: values["no-memo"],
    requireOptionalGoals: values["require-optional-goals"],
    list: values.list,
  };
}

class Worker {
  constructor(options) {
    this.options = options;
    this.log = "";
    this.alive = true;
    this.process = fork(path.join(directory, "worker.mjs"), [], {
      execArgv: ["--experimental-vm-modules"],
      env: { ...process.env, NODE_ENV: "development" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    for (const stream of [this.process.stdout, this.process.stderr])
      stream.on("data", (chunk) => {
        this.log = `${this.log}${chunk}`.slice(-65536);
      });
    this.process.on("message", (message) => {
      if (message.type === "progress") {
        const { progress } = message;
        this.lastProgress = {
          variant: progress.variant,
          phase: progress.phase,
          step: progress.step,
        };
        const prior = this.partial[progress.variant] ?? {};
        this.partial[progress.variant] = progress.result ?? {
          ...prior,
          ...(progress.code
            ? {
                code: progress.code,
                diagnostics: progress.diagnostics,
                analysis: progress.analysis,
              }
            : {}),
          ...(progress.counts ? { counts: progress.counts } : {}),
        };
      } else if (message.type === "error") this.finish(new Error(JSON.stringify(message.error)));
      else this.finish(null, message);
    });
    this.process.on("error", (error) => this.finish(error));
    this.process.on("exit", (code, signal) => {
      this.alive = false;
      this.finish(new Error(`Worker exited (code=${code}, signal=${signal})`));
    });
  }

  finish(error, value) {
    if (!this.pending) return;
    clearTimeout(this.timer);
    const { resolve, reject } = this.pending;
    this.pending = null;
    if (error) reject(error);
    else resolve(value);
  }

  request(message) {
    if (!this.alive) return Promise.reject(new Error("Worker is not alive"));
    if (this.pending) return Promise.reject(new Error("Concurrent worker request"));
    this.partial = {};
    this.lastProgress = null;
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.timer = setTimeout(() => {
        this.finish(
          new Error(
            `Hard timeout after ${this.options.timeoutMs} ms; last phase: ${JSON.stringify(this.lastProgress)}`,
          ),
        );
        this.close();
      }, this.options.timeoutMs);
      this.process.send(message);
    });
  }

  initialize() {
    return this.request({
      type: "initialize",
      sourceOnly: this.options.sourceOnly,
      binding: this.options.binding,
      noMemo: this.options.noMemo,
    });
  }

  async run(task) {
    try {
      const response = await this.request({ type: "task", task });
      if (response.type !== "result")
        throw new Error(`Unexpected worker response: ${response.type}`);
      return response.result;
    } catch (error) {
      const variants = Object.fromEntries(
        Object.entries(this.partial).map(([name, result]) => [
          name,
          {
            variant: name,
            failures: [],
            samples: [],
            diagnostics: [],
            ...result,
          },
        ]),
      );
      return {
        task,
        source: buildCase(task).source,
        variants,
        incomplete: true,
        lastProgress: this.lastProgress,
        workerLog: this.log,
        findings: [
          {
            classification: "infrastructure-failure",
            kind: "infrastructure",
            check: "worker",
            error: errorRecord(error),
          },
        ],
      };
    }
  }

  close() {
    if (this.alive) this.process.kill("SIGKILL");
    this.alive = false;
  }
}

function compactResult(result) {
  return {
    ...result,
    source: undefined,
    sourceSha256: digest(result.source),
    variants: Object.fromEntries(
      Object.entries(result.variants).map(([name, variant]) => [
        name,
        {
          ...variant,
          code: undefined,
          codeSha256: variant.code ? digest(variant.code) : null,
          codeBytes: variant.code ? Buffer.byteLength(variant.code) : null,
        },
      ]),
    ),
  };
}

function saveReproduction(result, options) {
  const name = `${result.task.id.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}-${digest(result.task.id).slice(0, 8)}`;
  const destination = path.join(options.output, "cases", name);
  mkdirSync(destination, { recursive: true });
  writeFileSync(path.join(destination, "source.jsx"), `${result.source}\n`);
  for (const [variant, detail] of Object.entries(result.variants)) {
    if (detail.code) writeFileSync(path.join(destination, `${variant}.mjs`), `${detail.code}\n`);
  }
  writeFileSync(path.join(destination, "result.json"), json(result));
  writeFileSync(
    path.join(destination, "repro.json"),
    json({
      task: result.task,
      binding: options.binding,
      sourceOnly: options.sourceOnly,
      noMemo: options.noMemo,
    }),
  );
  const command = [
    process.execPath,
    path.join(directory, "run.mjs"),
    "--repro",
    path.join(destination, "repro.json"),
    "--binding",
    options.binding,
  ];
  if (options.sourceOnly) command.push("--source-only");
  if (options.noMemo) command.push("--no-memo");
  writeFileSync(
    path.join(destination, "reproduce.sh"),
    `#!/bin/sh\nexec ${command.map(quote).join(" ")} "$@"\n`,
  );
  return path.relative(options.output, destination);
}

function addCounts(target, counts = {}) {
  for (const [name, count] of Object.entries(counts)) target[name] = (target[name] ?? 0) + count;
}

function summarize(results, options, suite, canary, metadata, started, stopped) {
  const byVariant = {};
  const findings = {};
  const diagnosticCounts = {};
  const acceptedNoCacheFunctions = {};
  const families = {};
  const uniqueSources = new Set();
  let variants = 0;
  let incomplete = 0;
  for (const result of results) {
    uniqueSources.add(digest(result.source));
    incomplete += Number(Boolean(result.incomplete));
    for (const finding of result.findings)
      findings[finding.classification] = (findings[finding.classification] ?? 0) + 1;
    for (const [variant, detail] of Object.entries(result.variants)) {
      variants++;
      byVariant[variant] ??= {};
      addCounts(byVariant[variant], detail.counts);
      diagnosticCounts[variant] = (diagnosticCounts[variant] ?? 0) + detail.diagnostics.length;
      if (variant !== "source" && !variant.startsWith("noMemo")) {
        for (const [name, expectation] of Object.entries(result.cacheExpectations ?? {})) {
          if (
            !detail.analysis?.functions[name]?.cacheCalls &&
            (expectation === "preserve" ||
              expectation === "forbidden" ||
              (expectation === "enabled-required" && variant === "disabled"))
          ) {
            acceptedNoCacheFunctions[variant] = (acceptedNoCacheFunctions[variant] ?? 0) + 1;
          }
        }
      }
    }
    if (!["generated", "prior"].includes(result.task.kind) || result.task.id.startsWith("canary/"))
      continue;
    const name = result.task.family;
    families[name] ??= {
      executedPermutations: 0,
      variants: {},
      requiredGoal: result.optimizationGoal?.required ?? false,
    };
    const family = families[name];
    family.executedPermutations++;
    for (const [variant, detail] of Object.entries(result.variants)) {
      family.variants[variant] ??= {
        identitySignatures: new Map(),
        semanticFailureCases: 0,
        memoizedFunctions: 0,
      };
      const observed = family.variants[variant];
      if (detail.failures.length || result.incomplete) observed.semanticFailureCases++;
      else {
        const signature = JSON.stringify(
          detail.samples.map(({ label, same }) => ({ label, same })),
        );
        const entry = observed.identitySignatures.get(signature) ?? {
          cases: 0,
          example: result.task.id,
        };
        entry.cases++;
        observed.identitySignatures.set(signature, entry);
      }
      if (
        detail.analysis?.functions.SchedulingProbe?.cacheCalls ||
        detail.analysis?.functions.useSchedulingProbe?.cacheCalls
      )
        observed.memoizedFunctions++;
    }
  }
  for (const family of Object.values(families)) {
    for (const observed of Object.values(family.variants)) {
      observed.distinctIdentitySignatures = observed.identitySignatures.size;
      observed.identitySignatures = [...observed.identitySignatures].map(([signature, detail]) => ({
        sha256: digest(signature),
        ...detail,
      }));
    }
  }
  const hardFindings = Object.entries(findings).filter(
    ([name]) => !isInformationalFinding(name, options.requireOptionalGoals),
  );
  let status = options.sourceOnly ? "source-validated-only" : "passed";
  let exitCode = 0;
  if (hardFindings.length) {
    status = "failed";
    exitCode = 1;
  }
  if (incomplete || stopped) {
    status = "incomplete";
    exitCode = 3;
  }
  if (!options.sourceOnly && canary && !canary.passed) {
    status = "blocked-inactive-or-failing-canary";
    exitCode = 2;
  }
  const suiteResults = results.filter((result) => !result.task.id.startsWith("canary/"));
  return {
    schemaVersion: 1,
    status,
    exitCode,
    schedulerEvidence: !options.sourceOnly && Boolean(canary?.passed) && !incomplete && !stopped,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    started: new Date(started).toISOString(),
    finished: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    options,
    metadata,
    canary,
    planned: {
      suiteCases: suite.tasks.length,
      suiteVariants: suite.tasks.length * (options.sourceOnly ? 1 : options.noMemo ? 5 : 3),
      generatedPermutations: suite.tasks.filter((task) =>
        ["generated", "prior"].includes(task.kind),
      ).length,
      controls: suite.tasks.filter((task) => task.kind === "control").length,
      coverage: suite.coverage,
    },
    actual: {
      attemptedCases: results.length,
      completedCases: results.length - incomplete,
      suiteCases: suiteResults.length,
      canaryCases: results.length - suiteResults.length,
      generatedPermutations: suiteResults.filter(({ task }) =>
        ["generated", "prior"].includes(task.kind),
      ).length,
      controls: suiteResults.filter(({ task }) => task.kind === "control").length,
      caseVariants: variants,
      uniqueSources: uniqueSources.size,
      incompleteCases: incomplete,
      countsExact: !incomplete,
      countsIncludeCanary: true,
      byVariant,
    },
    findings,
    expectedBaselineDefects: {
      declared: results.reduce(
        (sum, result) => sum + (result.expectedBaselineDefects?.length ?? 0),
        0,
      ),
      checked: results.reduce(
        (sum, result) =>
          sum + (result.variants.disabled ? (result.expectedBaselineDefects?.length ?? 0) : 0),
        0,
      ),
      observed: findings["expected-baseline-defect"] ?? 0,
      mismatches: findings["expected-baseline-defect-mismatch"] ?? 0,
    },
    diagnosticCounts,
    acceptedNoCacheFunctions,
    families,
    failingCases: results
      .filter((result) => result.findings.length)
      .map((result) => ({
        id: result.task.id,
        classes: [...new Set(result.findings.map(({ classification }) => classification))],
        artifact: result.artifact,
      })),
    stopped,
    scope:
      "Bounded deterministic source families and selected React lifecycle scenarios; not exhaustive JavaScript or a wall-time performance claim.",
  };
}

async function main() {
  const options = optionsFromArgs();
  if (!options) return;
  const generated = generateSuite(options);
  const repro = options.repro ? JSON.parse(readFileSync(options.repro, "utf8")) : null;
  const tasks = repro
    ? [repro.task]
    : generated.tasks.filter(
        (task) =>
          (!options.filter || task.id.includes(options.filter)) &&
          (!options.cases || options.cases.includes(task.id)),
      );
  if (!tasks.length) throw new Error("Selection matched zero cases");
  if (options.cases && tasks.length !== new Set(options.cases).size)
    throw new Error(
      "At least one --case ID was not selected; use --repro for saved tasks outside this mode",
    );
  const suite = {
    tasks,
    coverage: generated.coverage.map((entry) => ({
      ...entry,
      selected: tasks.filter((task) => task.family === entry.family).length,
    })),
  };
  if (options.list) {
    console.log(
      json({
        ...suite,
        plannedRenderRequests: tasks.reduce(
          (sum, task) =>
            sum +
            (buildCase(task).compileOnly ? 0 : buildCase(task).updates.length) *
              (options.sourceOnly ? 1 : options.noMemo ? 5 : 3),
          0,
        ),
      }),
    );
    return;
  }
  if (existsSync(path.join(options.output, "manifest.json")))
    throw new Error(`Output already contains a run: ${options.output}`);
  mkdirSync(options.output, { recursive: true });
  const started = Date.now();
  writeFileSync(
    path.join(options.output, "manifest.json"),
    json({ options, tasks, coverage: suite.coverage, started: new Date(started).toISOString() }),
  );
  const workers = new Set();
  const results = [];
  const metadata = [];
  let canary;
  let stopped = null;
  let queue = 0;
  const stop = (reason) => {
    stopped ??= reason;
    for (const worker of workers) worker.close();
  };
  const signal = () => stop("Interrupted");
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  const overallTimer = setTimeout(
    () => stop(`Whole-run timeout after ${options.runTimeoutMs} ms`),
    options.runTimeoutMs,
  );
  const addResult = (result, alwaysSave = false) => {
    if (result.findings.length || alwaysSave) result.artifact = saveReproduction(result, options);
    results.push(result);
    appendFileSync(
      path.join(options.output, "cases.jsonl"),
      `${JSON.stringify(compactResult(result))}\n`,
    );
  };
  const startWorker = async () => {
    const worker = new Worker(options);
    workers.add(worker);
    const ready = await worker.initialize();
    metadata.push({ binding: ready.metadata, versions: ready.versions });
    if (ready.versions.react !== "19.2.3" || ready.versions["react-test-renderer"] !== "19.2.3")
      throw new Error("Pinned React/renderer versions are required");
    if (metadata.length > 1 && JSON.stringify(metadata[0]) !== JSON.stringify(metadata.at(-1)))
      throw new Error("Worker dependency or binding fingerprints differ");
    return worker;
  };
  try {
    const first = await startWorker();
    if (!options.sourceOnly) {
      const result = await first.run(canaryTask(options.seed));
      canary = assessCanary(result, options.noMemo);
      addResult(result, true);
      console.error(`Scheduler canary: ${canary.passed ? "PASS" : "BLOCKED"} (${canary.reason})`);
    }
    if (options.sourceOnly || canary?.passed) {
      const consume = async (initial) => {
        let worker = initial;
        while (!stopped && queue < tasks.length) {
          const task = tasks[queue++];
          if (task.id.startsWith("canary/") && !options.sourceOnly) continue;
          if (!worker.alive) worker = await startWorker();
          const result = await worker.run(task);
          addResult(result);
          if (results.length % 50 === 0 || result.incomplete)
            console.error(
              `Completed ${results.length}/${tasks.length + (options.sourceOnly ? 0 : 1)} case attempts`,
            );
        }
      };
      const consumers = [consume(first)];
      for (let index = 1; index < Math.min(options.jobs, tasks.length); index++)
        consumers.push(startWorker().then(consume));
      await Promise.all(consumers);
    }
  } catch (error) {
    stop(`Infrastructure error: ${error.message}`);
    writeFileSync(
      path.join(options.output, "infrastructure-error.json"),
      json({ error: errorRecord(error), workerLogs: [...workers].map((worker) => worker.log) }),
    );
  } finally {
    clearTimeout(overallTimer);
    for (const worker of workers) worker.close();
    process.removeListener("SIGINT", signal);
    process.removeListener("SIGTERM", signal);
  }
  for (const artifact of metadata[0]?.binding?.artifacts ?? []) {
    if (!existsSync(artifact.path) || digest(readFileSync(artifact.path)) !== artifact.sha256)
      stopped ??= "Binding artifact changed during the run";
  }
  const summary = summarize(results, options, suite, canary, metadata[0] ?? null, started, stopped);
  writeFileSync(path.join(options.output, "summary.json"), json(summary));
  console.log(
    json({
      status: summary.status,
      schedulerEvidence: summary.schedulerEvidence,
      actual: summary.actual,
      findings: summary.findings,
      summary: path.join(options.output, "summary.json"),
    }),
  );
  process.exitCode = summary.exitCode;
}

await main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 3;
});
