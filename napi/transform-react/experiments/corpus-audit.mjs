#!/usr/bin/env node

// Compile-only differential audit. Generated output is never evaluated.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { cpus, totalmem } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT), "../../..");
const FLAG = "enableInstructionReordering";
const MODES = ["omitted", "off", "on"];
const NO_MEMO_MODES = ["noMemoOff", "noMemoOn"];
const PROTOCOL = "@@corpus-audit ";
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|jsx|tsx)$/;
const ENVIRONMENT_BOOLEANS = new Set([
  "enableResetCacheOnSourceFileChanges",
  "enablePreserveExistingMemoizationGuarantees",
  "validatePreserveExistingMemoizationGuarantees",
  "validateExhaustiveMemoizationDependencies",
  "enableOptionalDependencies",
  "enableNameAnonymousFunctions",
  "validateHooksUsage",
  "validateRefAccessDuringRender",
  "validateNoSetStateInRender",
  "enableUseKeyedState",
  "validateNoSetStateInEffects",
  "validateNoDerivedComputationsInEffects",
  "validateNoDerivedComputationsInEffectsExp",
  "validateNoJsxInTryStatements",
  "validateStaticComponents",
  "validateSourceLocations",
  "validateNoImpureFunctionsInRender",
  "validateNoFreezingKnownMutableFunctions",
  "enableAssumeHooksFollowRulesOfReact",
  "enableTransitivelyFreezeFunctionExpressions",
  "enableFunctionOutlining",
  "enableJsxOutlining",
  "assertValidMutableRanges",
  "enableCustomTypeDefinitionForReanimated",
  "enableTreatRefLikeIdentifiersAsRefs",
  "enableTreatSetIdentifiersAsStateSetters",
  "validateNoVoidUseMemo",
  "enableAllowSetStateFromRefsInEffects",
  "enableVerboseNoSetStateInEffect",
  "enableForest",
  "disableMemoizationForTesting",
]);
const ALIASES = {
  validateNoJSXInTryStatements: "validateNoJsxInTryStatements",
  validateNoDerivedComputationsInEffects_exp: "validateNoDerivedComputationsInEffectsExp",
  enableFlowSuppressions: "flowSuppressions",
};
const RUNNER_DIRECTIVES = new Set(["expectNothingCompiled", "debug", "skip", "xonly", "Pass"]);
const TEST_MODULES = [
  "ReactCompilerKnownIncompatibleTest",
  "ReactCompilerNoAliasTest",
  "ReactCompilerTest",
  "ReactCompilerPureTagTest",
  "useDefaultExportNotTypedAsHook",
];
const CANARY_SOURCE = `import {useState} from 'react';
export function Component() {
  const value = [];
  useState(0);
  value.push(1);
  return value;
}
`;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const slash = (path) => path.replaceAll("\\", "/");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
const elapsed = (start) => Number(process.hrtime.bigint() - start) / 1e6;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort(compare)
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function fingerprint(path) {
  const actual = realpathSync(path);
  const before = statSync(actual);
  const hash = sha256(readFileSync(actual));
  const after = statSync(actual);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`File changed while hashing: ${actual}`);
  }
  return { path: actual, bytes: after.size, sha256: hash, mtimeMs: after.mtimeMs };
}

function compilerIdentity(binding, nativePaths, target) {
  const loader = fingerprint(binding);
  const binaries = nativePaths.map(fingerprint).sort((a, b) => compare(a.path, b.path));
  return {
    loader,
    binaries,
    target,
    sha256: sha256(
      stable({ loader: loader.sha256, binaries: binaries.map((b) => b.sha256), target }),
    ),
  };
}

function optionsFor(options, mode) {
  const result = clone(options);
  delete result.reactCompiler.environment[FLAG];
  if (mode !== "omitted") {
    result.reactCompiler.environment[FLAG] = mode === "on" || mode === "noMemoOn";
  }
  if (NO_MEMO_MODES.includes(mode)) {
    result.reactCompiler.environment.disableMemoizationForTesting = true;
  }
  return result;
}

function baseOptions(fixture) {
  return {
    ...(fixture ? { lang: "tsx", sourceType: "module" } : {}),
    jsx: "preserve",
    sourcemap: false,
    reactCompiler: {
      compilationMode: fixture ? "all" : "infer",
      panicThreshold: fixture ? "all_errors" : "none",
      reportDiagnostics: true,
      environment: fixture ? { validatePreserveExistingMemoizationGuarantees: false } : {},
    },
  };
}

// Only first-line // pragmas are interpreted. @ inside a JSON string is not a separator.
function pragmaEntries(source) {
  const first = source.split(/\r?\n/, 1)[0].replace(/^\uFEFF/, "");
  if (!/^\s*\/\//.test(first)) return [];
  const starts = [];
  let quoted = false;
  let escaped = false;
  for (let i = first.indexOf("//") + 2; i < first.length; i++) {
    const c = first[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "@" && /\s/.test(first[i - 1])) starts.push(i);
  }
  return starts.map((start, index) => first.slice(start, starts[index + 1]).trim());
}

function parseFixtureOptions(source) {
  const options = baseOptions(true);
  const compiler = options.reactCompiler;
  const applied = [];
  const unsupported = [];
  const runnerOnly = [];
  const controlled = [];
  let flow = false;
  for (const raw of pragmaEntries(source)) {
    const match = /^@([\w]+)(?::([\s\S]*))?$/.exec(raw);
    const key = /^@([\w]+)/.exec(raw)?.[1] ?? raw;
    if (RUNNER_DIRECTIVES.has(key)) {
      runnerOnly.push({ key, raw, action: "recorded; file is still compiled" });
      continue;
    }
    if (key === "flow") {
      flow = true;
      unsupported.push({ key, raw, reason: "Flow parsing is unavailable; source is skipped" });
      continue;
    }
    if (key === FLAG) {
      controlled.push({ key, raw, reason: "audit supplies omitted, false, and true variants" });
      continue;
    }
    if (!match) {
      unsupported.push({ key, raw, reason: "expected @key or @key:JSON on the first line" });
      continue;
    }
    let value = true;
    try {
      if (match[2] !== undefined) value = JSON.parse(match[2]);
    } catch {
      if (
        [
          "compilationMode",
          "panicThreshold",
          "outputMode",
          "target",
          "validateExhaustiveEffectDependencies",
        ].includes(key)
        && /^[\w-]+$/.test(match[2])
      ) {
        value = match[2];
      } else {
        unsupported.push({
          key,
          raw,
          reason: "value is not a JSON literal or supported bare enum",
        });
        continue;
      }
    }
    const name = ALIASES[key] ?? key;
    const isStrings = Array.isArray(value) && value.every((v) => typeof v === "string");
    let supported = true;
    if (ENVIRONMENT_BOOLEANS.has(name) && typeof value === "boolean") {
      compiler.environment[name] = value;
    } else if (name === "script" && value === true) {
      options.sourceType = "script";
    } else if (
      (name === "compilationMode" && ["all", "annotation", "infer", "syntax"].includes(value))
      || (name === "panicThreshold" && ["none", "critical_errors", "all_errors"].includes(value))
      || (name === "outputMode" && ["client", "ssr", "lint"].includes(value))
    ) {
      compiler[name] = value;
    } else if (
      ["flowSuppressions", "ignoreUseNoForget", "noEmit"].includes(name)
      && typeof value === "boolean"
    ) {
      compiler[name] = value;
    } else if (
      ["customOptOutDirectives", "eslintSuppressionRules", "sources"].includes(name)
      && isStrings
    ) {
      compiler[name] = value;
    } else if (name === "target" && ["17", "18", "19", "donotuse_meta_internal"].includes(value)) {
      compiler.target = value === "donotuse_meta_internal" ? { kind: value } : value;
    } else if (name === "gating" && value === true) {
      compiler.gating = {
        source: "ReactForgetFeatureFlag",
        importSpecifierName: "isForgetEnabled_Fixtures",
      };
    } else if (
      name === "dynamicGating"
      && value !== null
      && typeof value === "object"
      && Object.keys(value).length === 1
      && typeof value.source === "string"
    ) {
      compiler.dynamicGating = value;
    } else if (
      ["validateNoCapitalizedCalls", "validateBlocklistedImports"].includes(name)
      && (isStrings || value === true)
    ) {
      compiler.environment[name] = value === true ? [] : value;
    } else if (
      name === "validateExhaustiveEffectDependencies"
      && (value === true || ["off", "all", "missing-only", "extra-only"].includes(value))
    ) {
      compiler.environment[name] = value === true ? "all" : value;
    } else if (name === "customMacros" && typeof value === "string") {
      // The local Rust snapshot runner also retains only the first path segment.
      compiler.environment.customMacros = [value.split(".")[0]];
      if (value.includes(".")) {
        unsupported.push({
          key: "customMacros.memberPath",
          raw,
          reason: "native macro names cannot express member paths",
        });
      }
    } else {
      supported = false;
      unsupported.push({
        key,
        raw,
        reason: "option or value is not supported by this NAPI pragma adapter",
      });
    }
    if (supported) applied.push({ key, nativeKey: name, value });
  }
  // Match the snapshot runner's presence-based override, including :false.
  compiler.environment.validatePreserveExistingMemoizationGuarantees = source
    .split(/\r?\n/, 1)[0]
    .includes("@validatePreserveExistingMemoizationGuarantees");
  for (const module of TEST_MODULES) {
    if (source.includes(`'${module}'`) || source.includes(`"${module}"`)) {
      unsupported.push({
        key: "moduleTypeProvider",
        module,
        reason: "snapshot test module-type provider is not exposed by NAPI",
      });
    }
  }
  return { options, pragmas: { applied, unsupported, runnerOnly, controlled }, flow };
}

function diagnosticDifference(left, right) {
  const counts = new Map();
  for (const diagnostic of right) {
    const key = stable(diagnostic);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return left.filter((diagnostic) => {
    const key = stable(diagnostic);
    const count = counts.get(key) ?? 0;
    if (count === 0) return true;
    counts.set(key, count - 1);
    return false;
  });
}

function resultSignature(result) {
  if (result.kind === "result") {
    return sha256(stable({ code: result.code, errors: result.errors, fatal: result.fatal }));
  }
  return sha256(
    stable({
      kind: result.kind,
      name: result.name,
      message: result.message,
      failure: result.failure,
    }),
  );
}

function compareResults(results, checkDefault = true) {
  const { omitted, off, on } = results;
  const returned = (r) => r?.kind === "result";
  const complete = (checkDefault ? MODES : ["off", "on"]).every((mode) => returned(results[mode]));
  const defaultOffEqual =
    checkDefault && returned(omitted) && returned(off)
      ? resultSignature(omitted) === resultSignature(off)
      : null;
  const categories = [];
  const regressions = [];
  const both = returned(off) && returned(on);
  const outputChanged = both ? off.code !== on.code : null;
  const diagnosticsChanged = both ? stable(off.errors) !== stable(on.errors) : null;
  const addedDiagnostics = both ? diagnosticDifference(on.errors, off.errors) : [];
  const removedDiagnostics = both ? diagnosticDifference(off.errors, on.errors) : [];
  const addedInvariants = addedDiagnostics.filter(
    (d) =>
      /react-compiler\(Invariant\)/i.test(d.codeframe ?? "")
      || /\binvariant\b|internal compiler error/i.test(`${d.message} ${d.helpMessage ?? ""}`),
  );
  if (defaultOffEqual === false) regressions.push("omitted-vs-false-mismatch");
  if (outputChanged) categories.push("output-changed");
  if (diagnosticsChanged) categories.push("diagnostics-changed");
  if (addedDiagnostics.length > 0) regressions.push("added-diagnostics");
  if (addedInvariants.length > 0) regressions.push("added-invariant-diagnostics");
  if (both && on.fatal && !off.fatal) regressions.push("new-fatal");
  if (returned(off) && !returned(on)) regressions.push("new-execution-failure");
  if (both && off.fatal && !on.fatal) categories.push("resolved-fatal");
  if (both && (off.fatal || off.errors.length > 0)) {
    categories.push("inherited-diagnostics-or-fatal");
  }
  if (!complete) categories.push("incomplete-comparison");
  if (categories.length === 0 && regressions.length === 0) categories.push("unchanged");
  return {
    complete,
    defaultOffEqual,
    outputChanged,
    diagnosticsChanged,
    fatalChanged: both ? off.fatal !== on.fatal : null,
    addedDiagnostics,
    removedDiagnostics,
    addedInvariants,
    categories,
    regressions,
  };
}

function compileOne(transformSync, item, mode) {
  const options = optionsFor(item.options, mode);
  const start = process.hrtime.bigint();
  try {
    const result = transformSync(item.filename, item.source, options);
    const { code, errors, fatal } = result;
    const durationMs = elapsed(start);
    if (typeof code !== "string" || !Array.isArray(errors) || typeof fatal !== "boolean") {
      throw new Error("Invalid transformSync result: expected code, errors, and fatal");
    }
    return { kind: "result", code, errors: clone(errors), fatal, durationMs };
  } catch (error) {
    return {
      kind: "exception",
      name: error.name,
      message: error.message,
      stack: error.stack,
      durationMs: elapsed(start),
    };
  }
}

function emit(message) {
  writeFileSync(1, `${PROTOCOL}${JSON.stringify(message)}\n`);
}

function benchmarkWorker(request, transformSync) {
  const rounds = [];
  const { warmups, repetitions } = request.benchmark;
  for (let round = -warmups; round < repetitions; round++) {
    const order = (round + warmups) % 2 === 0 ? ["off", "on"] : ["on", "off"];
    const measurement = { round, order, offMs: 0, onMs: 0, perFile: [] };
    for (const mode of order) {
      for (const item of request.items) {
        emit({ type: "start", id: item.id, mode, round });
        const result = compileOne(transformSync, item, mode);
        if (result.kind !== "result" || resultSignature(result) !== item.expected[mode]) {
          emit({ type: "benchmark-failure", id: item.id, mode, round, result });
          return;
        }
        measurement[`${mode}Ms`] += result.durationMs;
        if (round >= 0) measurement.perFile.push({ id: item.id, mode, ms: result.durationMs });
      }
    }
    if (round >= 0) rounds.push(measurement);
  }
  emit({ type: "benchmark", rounds });
}

async function worker() {
  try {
    const request = JSON.parse(readFileSync(0, "utf8"));
    if (sha256(readFileSync(SCRIPT)) !== request.harnessSha256) {
      throw new Error("Audit script changed during the run");
    }
    const loaderBefore = fingerprint(request.binding);
    const require = createRequire(import.meta.url);
    const binding = await import(pathToFileURL(request.binding).href);
    const transformSync = binding.transformSync ?? binding.default?.transformSync;
    const target = binding.__napiBindingTarget ?? binding.default?.__napiBindingTarget;
    const nativePaths = Object.keys(require.cache).filter((path) => path.endsWith(".node"));
    if (typeof transformSync !== "function" || target !== "native" || nativePaths.length === 0) {
      throw new Error(
        "--binding must load a native transformSync addon with a discoverable .node fingerprint",
      );
    }
    const identity = compilerIdentity(request.binding, nativePaths, target);
    if (loaderBefore.sha256 !== identity.loader.sha256) {
      throw new Error("Binding loader changed during import");
    }
    emit({ type: "identity", identity });
    if (request.benchmark) benchmarkWorker(request, transformSync);
    else {
      for (const item of request.items) {
        for (const mode of request.modes ?? MODES) {
          emit({ type: "start", id: item.id, mode });
          emit({
            type: "result",
            id: item.id,
            mode,
            result: compileOne(transformSync, item, mode),
          });
        }
      }
    }
    emit({ type: "identity", identity: compilerIdentity(request.binding, nativePaths, target) });
    emit({ type: "complete" });
  } catch (error) {
    emit({ type: "worker-error", name: error.name, message: error.message, stack: error.stack });
    process.exitCode = 1;
  }
}

function usage() {
  return `Usage: node ${slash(relative(process.cwd(), SCRIPT))} [options]

Compile-only audit of omitted/false/true reactCompiler.environment.${FLAG}.
This checks output and diagnostics, NOT runtime semantics.

  --binding PATH               Absolute native package index.js (default ../index.js)
  --fixtures DIR               Fixture corpus (default crates/oxc_react_compiler/fixtures)
  --no-fixtures                Audit only --corpus inputs (still requires a passing canary)
  --corpus DIR                 Additional JS/TS source corpus; repeatable (e.g. App/src)
  --filter TEXT                Only paths containing TEXT; excluded files are counted
  --output PATH                JSON report (default ./corpus-audit.json)
  --artifacts DIR              Local sources/options/outputs for changes and failures
  --chunk-size N               Files per child, 1..256 (default 32)
  --timeout-ms N               Hard timeout per chunk (default 15000)
  --single-timeout-ms N        Hard timeout per isolated reproduction (default 5000)
  --budget-ms N               Whole audit budget, including benchmark (default 180000)
  --max-file-bytes N           Skip larger inputs explicitly (default 1048576)
  --stress-size N              Add inert chain + independent arrays, 0..2048 (default 0)
  --no-memo-differential       Also compare scheduling off/on with memoization disabled
  --benchmark                 Benchmark a deterministic clean-input sample after auditing
  --sample-size N              Benchmark corpus sample size (default 64), plus stress inputs
  --warmups N                  Alternating-order warmup rounds, 1..20 (default 2)
  --repetitions N              Alternating-order measured rounds, 4..100 (default 8)
  --benchmark-budget-ms N      Hard benchmark child timeout (default 30000)
  --benchmark-max-bytes N      Exclude larger benchmark inputs (default 32768)
  --help                       Show this help

Exit 0: no added diagnostics/fatal/errors and complete comparisons within stated coverage.
Exit 1: regression or failed canary. Exit 2: incomplete/empty audit or infrastructure failure.
`;
}

function parseArgs(args) {
  const settings = {
    binding: resolve(dirname(SCRIPT), "../index.js"),
    fixtures: resolve(ROOT, "crates/oxc_react_compiler/fixtures"),
    corpora: [],
    filter: "",
    output: resolve("corpus-audit.json"),
    artifacts: null,
    chunkSize: 32,
    timeoutMs: 15000,
    singleTimeoutMs: 5000,
    budgetMs: 180000,
    maxFileBytes: 1048576,
    stressSize: 0,
    noMemoDifferential: false,
    benchmark: false,
    sampleSize: 64,
    warmups: 2,
    repetitions: 8,
    benchmarkBudgetMs: 30000,
    benchmarkMaxBytes: 32768,
  };
  const numbers = {
    "--chunk-size": ["chunkSize", 1, 256],
    "--timeout-ms": ["timeoutMs", 50, 600000],
    "--single-timeout-ms": ["singleTimeoutMs", 50, 600000],
    "--budget-ms": ["budgetMs", 1000, 3600000],
    "--max-file-bytes": ["maxFileBytes", 1, 16777216],
    "--stress-size": ["stressSize", 0, 2048],
    "--sample-size": ["sampleSize", 1, 2048],
    "--warmups": ["warmups", 1, 20],
    "--repetitions": ["repetitions", 4, 100],
    "--benchmark-budget-ms": ["benchmarkBudgetMs", 1000, 600000],
    "--benchmark-max-bytes": ["benchmarkMaxBytes", 1, 1048576],
  };
  const paths = {
    "--binding": "binding",
    "--fixtures": "fixtures",
    "--output": "output",
    "--artifacts": "artifacts",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help") return null;
    if (arg === "--no-fixtures") settings.fixtures = null;
    else if (arg === "--benchmark") settings.benchmark = true;
    else if (arg === "--no-memo-differential") settings.noMemoDifferential = true;
    else if (
      Object.hasOwn(numbers, arg)
      || Object.hasOwn(paths, arg)
      || ["--corpus", "--filter"].includes(arg)
    ) {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      if (Object.hasOwn(numbers, arg)) {
        const [name, min, max] = numbers[arg];
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < min || number > max) {
          throw new Error(`${arg} must be an integer in ${min}..${max}`);
        }
        settings[name] = number;
      } else if (arg === "--corpus") settings.corpora.push(resolve(value));
      else if (arg === "--filter") settings.filter = value;
      else {
        if (arg === "--binding" && !isAbsolute(value)) {
          throw new Error("--binding must be absolute");
        }
        settings[paths[arg]] = resolve(value);
      }
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  settings.artifacts ??= settings.output.replace(/\.json$/, "") + ".artifacts";
  return settings;
}

function git(path, args) {
  const result = spawnSync("git", ["-C", path, ...args], { encoding: "utf8", timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function provenance(root) {
  const repositoryRoot = git(root, ["rev-parse", "--show-toplevel"]);
  const licenses = [];
  let directory = root;
  while (true) {
    for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "NOTICE"]) {
      const path = join(directory, name);
      if (existsSync(path) && statSync(path).isFile() && statSync(path).size <= 65536) {
        const text = readFileSync(path, "utf8");
        licenses.push({ path, sha256: sha256(text), text });
      }
    }
    if (directory === repositoryRoot || dirname(directory) === directory) break;
    directory = dirname(directory);
  }
  return { repositoryRoot, revision: git(root, ["rev-parse", "HEAD"]), licenses };
}

function sourceMetadata(source) {
  return {
    copyrightNotices: [...new Set(source.match(/copyright[^\r\n]*/gi) ?? [])],
    spdxIdentifiers: [...new Set(source.match(/SPDX-License-Identifier:[^\r\n]*/g) ?? [])],
  };
}

function collectCorpus(root, id, fixture, settings) {
  const corpus = {
    id,
    root,
    fixture,
    provenance: null,
    sourceCandidates: 0,
    ignoredExtensions: 0,
    skippedEntries: [],
    skippedSources: [],
    items: [],
    errors: [],
  };
  try {
    if (!statSync(root).isDirectory()) throw new Error("corpus root is not a directory");
    corpus.provenance = provenance(root);
    const directories = [root];
    while (directories.length > 0) {
      const directory = directories.pop();
      const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        compare(a.name, b.name),
      );
      for (const entry of entries) {
        const path = join(directory, entry.name);
        const name = slash(relative(root, path));
        if (entry.isSymbolicLink()) {
          corpus.skippedEntries.push({ path: name, reason: "symlink-not-followed" });
          continue;
        }
        if (entry.isDirectory()) {
          if ([".git", "node_modules"].includes(entry.name) || path === settings.artifacts) {
            corpus.skippedEntries.push({
              path: name,
              reason: "excluded-directory (descendants not enumerated)",
            });
          } else directories.push(path);
          continue;
        }
        if (!entry.isFile() || !SOURCE_EXTENSION.test(entry.name)) {
          corpus.ignoredExtensions++;
          continue;
        }
        corpus.sourceCandidates++;
        const item = {
          id: `${id}/${name}`,
          corpus: id,
          relativePath: name,
          filename: path,
          fixture,
        };
        try {
          item.bytes = statSync(path).size;
          if (item.bytes > settings.maxFileBytes) {
            corpus.skippedSources.push({
              ...item,
              reason: "max-file-bytes",
              limit: settings.maxFileBytes,
            });
            continue;
          }
          const bytes = readFileSync(path);
          item.rawSha256 = sha256(bytes);
          item.source = bytes.toString("utf8");
          if (fixture) item.source = item.source.replace(/\r\n?/g, "\n");
          item.inputSha256 = sha256(item.source);
          Object.assign(item, sourceMetadata(item.source));
          const parsed = fixture
            ? parseFixtureOptions(item.source)
            : {
                options: baseOptions(false),
                pragmas: { applied: [], unsupported: [], runnerOnly: [], controlled: [] },
                flow: false,
              };
          item.options = parsed.options;
          item.pragmas = parsed.pragmas;
          item.configSha256 = sha256(stable(item.options));
          let reason = null;
          if (/\.d\.[cm]?ts$/.test(name)) reason = "declaration-file";
          else if (parsed.flow) reason = "unsupported-flow";
          else if (settings.filter && !item.id.includes(settings.filter)) reason = "filter";
          if (reason) {
            const { source: _source, ...metadata } = item;
            corpus.skippedSources.push({ ...metadata, reason });
          } else corpus.items.push(item);
        } catch (error) {
          corpus.skippedSources.push({
            id: item.id,
            relativePath: name,
            reason: "read-error",
            message: error.message,
          });
          corpus.errors.push({ path: name, message: error.message });
        }
      }
    }
  } catch (error) {
    corpus.errors.push({ path: root, message: error.message });
  }
  corpus.items.sort((a, b) => compare(a.id, b.id));
  corpus.skippedSources.sort((a, b) => compare(a.id, b.id));
  corpus.skippedEntries.sort((a, b) => compare(a.path, b.path));
  return corpus;
}

function generatedItem(id, source) {
  const options = baseOptions(true);
  return {
    id,
    corpus: "generated",
    relativePath: `${id}.tsx`,
    filename: `${id}.tsx`,
    fixture: true,
    source,
    bytes: Buffer.byteLength(source),
    inputSha256: sha256(source),
    rawSha256: sha256(source),
    configSha256: sha256(stable(options)),
    options,
    pragmas: { applied: [], unsupported: [], runnerOnly: [], controlled: [] },
    copyrightNotices: [],
    spdxIdentifiers: [],
  };
}

function stressItems(count) {
  if (count === 0) return [];
  const prefix = "import {useState} from 'react';\nexport function Component() {\n";
  const chain = [
    "const value0 = [];",
    ...Array.from({ length: count }, (_, i) => `const value${i + 1} = [value${i}];`),
    "useState(0);",
    `value${count}.push(1);`,
    `return value${count};`,
  ];
  const arrays = [
    ...Array.from({ length: count }, (_, i) => `const value${i} = [];`),
    "useState(0);",
    `return [${Array.from({ length: count }, (_, i) => `value${i}`).join(",")}];`,
  ];
  return [
    generatedItem(`stress/inert-chain-${count}`, `${prefix}${chain.join("\n")}\n}\n`),
    generatedItem(`stress/independent-arrays-${count}`, `${prefix}${arrays.join("\n")}\n}\n`),
  ];
}

function distribution(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const quantile = (q) => {
    const index = (sorted.length - 1) * q;
    const low = Math.floor(index);
    return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
  };
  return {
    count: values.length,
    min: sorted[0],
    median: quantile(0.5),
    p90: quantile(0.9),
    p95: quantile(0.95),
    max: sorted.at(-1),
    mean,
    standardDeviation: Math.sqrt(
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length,
    ),
  };
}

function runAudit(settings) {
  const start = Date.now();
  const deadline = start + settings.budgetMs;
  const harnessSha256 = sha256(readFileSync(SCRIPT));
  const corpora = [];
  if (settings.fixtures) corpora.push(collectCorpus(settings.fixtures, "fixtures", true, settings));
  for (const [index, path] of [...new Set(settings.corpora)].sort(compare).entries()) {
    corpora.push(collectCorpus(path, `corpus-${index + 1}-${basename(path)}`, false, settings));
  }
  const items = [
    ...corpora.flatMap((corpus) => corpus.items),
    ...stressItems(settings.stressSize),
  ].sort((a, b) => compare(a.id, b.id));
  const skippedSources = corpora
    .flatMap((corpus) => corpus.skippedSources)
    .sort((a, b) => compare(a.id, b.id));
  const records = [];
  const modesToAudit = settings.noMemoDifferential ? [...MODES, ...NO_MEMO_MODES] : MODES;
  const resultsById = new Map();
  const workerFailures = [];
  const infrastructure = corpora.flatMap((corpus) =>
    corpus.errors.map((error) => ({ corpus: corpus.id, ...error })),
  );
  let compiler = null;
  let workerCount = 0;
  mkdirSync(settings.artifacts, { recursive: true });

  function runChild(chunk, modes, timeoutMs, benchmark) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { results: [], failure: { kind: "budget-exhausted" }, messages: [] };
    const attempt = ++workerCount;
    const request = { binding: settings.binding, harnessSha256, items: chunk, modes, benchmark };
    const child = spawnSync(process.execPath, [SCRIPT, "--worker"], {
      input: JSON.stringify(request),
      encoding: "utf8",
      timeout: Math.min(timeoutMs, remaining),
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1" },
    });
    const messages = [];
    let protocolError = null;
    for (const line of (child.stdout ?? "").split("\n")) {
      if (!line.startsWith(PROTOCOL)) continue;
      try {
        messages.push(JSON.parse(line.slice(PROTOCOL.length)));
      } catch (error) {
        protocolError = error.message;
      }
    }
    for (const message of messages.filter((m) => m.type === "identity")) {
      if (compiler === null) compiler = message.identity;
      else if (compiler.sha256 !== message.identity.sha256) {
        infrastructure.push({
          kind: "compiler-changed",
          attempt,
          expected: compiler.sha256,
          actual: message.identity.sha256,
        });
      }
    }
    let failure = null;
    if (
      child.error
      || child.signal
      || child.status !== 0
      || protocolError
      || !messages.some((m) => m.type === "complete")
    ) {
      failure = {
        attempt,
        kind:
          child.error?.code === "ETIMEDOUT" ? "timeout" : child.signal ? "signal" : "worker-error",
        status: child.status,
        signal: child.signal,
        error: child.error?.message ?? protocolError,
        lastStarted: messages.findLast((m) => m.type === "start") ?? null,
        workerError: messages.find((m) => m.type === "worker-error") ?? null,
        ids: chunk.map((item) => item.id),
        modes,
        timeoutMs: Math.min(timeoutMs, remaining),
      };
      const artifact = join(settings.artifacts, "workers", String(attempt).padStart(5, "0"));
      writeJson(`${artifact}.json`, failure);
      writeFileSync(`${artifact}.stderr.txt`, child.stderr ?? "");
      writeFileSync(`${artifact}.stdout.txt`, child.stdout ?? "");
      failure.artifact = artifact;
      workerFailures.push(failure);
    }
    return { results: messages.filter((m) => m.type === "result"), failure, messages };
  }

  function auditChunk(chunk, selectedModes = modesToAudit) {
    const collected = new Map(chunk.map((item) => [item.id, {}]));
    let pending = chunk;
    while (pending.length > 0) {
      const result = runChild(pending, selectedModes, settings.timeoutMs);
      for (const message of result.results) {
        collected.get(message.id)[message.mode] = message.result;
      }
      pending = pending.filter((item) =>
        selectedModes.some((mode) => !collected.get(item.id)[mode]),
      );
      if (pending.length === 0) break;
      if (Date.now() >= deadline) {
        for (const item of pending) {
          for (const mode of selectedModes) {
            collected.get(item.id)[mode] ??= {
              kind: "worker-failure",
              failure: { kind: "budget-exhausted" },
            };
          }
        }
        break;
      }
      // Completed results survive a crash. Isolate the interrupted input's
      // missing modes, then continue untouched inputs in bounded chunks.
      const interrupted =
        pending.find((item) => item.id === result.failure?.lastStarted?.id) ?? pending[0];
      const modes = collected.get(interrupted.id);
      for (const mode of selectedModes) {
        if (modes[mode]) continue;
        const isolated = runChild([interrupted], [mode], settings.singleTimeoutMs);
        modes[mode] = isolated.results.find((m) => m.id === interrupted.id && m.mode === mode)
          ?.result ?? {
          kind: "worker-failure",
          failure: isolated.failure ?? { kind: "missing-result" },
        };
      }
      pending = pending.filter((item) => item.id !== interrupted.id);
    }
    return collected;
  }

  function saveCase(item, results, comparison, noMemoComparison) {
    const artifact = join(settings.artifacts, "cases", sha256(item.id).slice(0, 20));
    mkdirSync(artifact, { recursive: true });
    writeFileSync(join(artifact, `input${extname(item.filename) || ".tsx"}`), item.source);
    writeJson(join(artifact, "config.json"), {
      id: item.id,
      filename: item.filename,
      inputSha256: item.inputSha256,
      configSha256: item.configSha256,
      modes: Object.fromEntries(
        Object.keys(results).map((mode) => [mode, optionsFor(item.options, mode)]),
      ),
      pragmas: item.pragmas,
      copyrightNotices: item.copyrightNotices,
      spdxIdentifiers: item.spdxIdentifiers,
    });
    writeJson(join(artifact, "results.json"), { comparison, noMemoComparison, results });
    for (const mode of Object.keys(results)) {
      if (results[mode]?.kind === "result") {
        writeFileSync(join(artifact, `${mode}.js`), results[mode].code);
      }
    }
    return artifact;
  }

  const canaryItem = generatedItem("canary/interleaved-array-hook", CANARY_SOURCE);
  const canaryResults = auditChunk([canaryItem]).get(canaryItem.id);
  const canaryComparison = compareResults(canaryResults);
  const noMemoCanary =
    !settings.noMemoDifferential
    || (NO_MEMO_MODES.every(
      (mode) =>
        canaryResults[mode]?.kind === "result"
        && !canaryResults[mode].fatal
        && canaryResults[mode].errors.length === 0
        && !canaryResults[mode].code.includes("react.memo_cache_sentinel"),
    )
      && canaryResults.noMemoOff.code !== canaryResults.noMemoOn.code
      && canaryResults.noMemoOn.code !== canaryResults.on.code);
  const canary = {
    passed:
      noMemoCanary
      && canaryComparison.complete
      && canaryComparison.defaultOffEqual
      && MODES.every(
        (mode) => !canaryResults[mode].fatal && canaryResults[mode].errors.length === 0,
      )
      && !canaryResults.off.code.includes("react.memo_cache_sentinel")
      && canaryResults.on.code.includes("react.memo_cache_sentinel")
      && canaryResults.on.code.includes("react/compiler-runtime")
      && canaryResults.off.code.indexOf("value = []")
        < canaryResults.off.code.indexOf("useState(0)")
      && canaryResults.on.code.indexOf("useState(0)") < canaryResults.on.code.indexOf("value = []")
      && canaryComparison.outputChanged,
    inputSha256: canaryItem.inputSha256,
    noMemoFlagRecognized: settings.noMemoDifferential ? noMemoCanary : null,
    explanation:
      "Default/off emits no memo cache; enabled sinks the literal allocation past the hook and emits a memo cache. This recognizes the flag, not semantic correctness.",
    comparison: canaryComparison,
    artifact: saveCase(canaryItem, canaryResults, canaryComparison),
  };

  if (canary.passed) {
    for (let offset = 0; offset < items.length && Date.now() < deadline;) {
      const chunk = [];
      let bytes = 0;
      while (offset < items.length && chunk.length < settings.chunkSize) {
        const item = items[offset];
        if (chunk.length > 0 && bytes + item.bytes > 8 * 1024 * 1024) break;
        chunk.push(item);
        bytes += item.bytes;
        offset++;
      }
      for (const [id, results] of auditChunk(chunk)) resultsById.set(id, results);
      for (const item of chunk) {
        const results = resultsById.get(item.id);
        const comparison = compareResults(results);
        const noMemoComparison = settings.noMemoDifferential
          ? compareResults({ off: results.noMemoOff, on: results.noMemoOn }, false)
          : null;
        const { source: _source, options: _options, ...metadata } = item;
        const record = { ...metadata, comparison, noMemoComparison, modes: {} };
        for (const mode of modesToAudit) {
          const result = results[mode];
          const { code, ...rest } = result;
          record.modes[mode] = {
            ...rest,
            configSha256: sha256(stable(optionsFor(item.options, mode))),
            resultSha256: resultSignature(result),
            ...(code === undefined
              ? {}
              : { codeSha256: sha256(code), codeBytes: Buffer.byteLength(code) }),
          };
        }
        if (
          [comparison, noMemoComparison]
            .filter(Boolean)
            .some(
              (c) =>
                c.outputChanged || c.diagnosticsChanged || c.regressions.length > 0 || !c.complete,
            )
          || modesToAudit.some((mode) => results[mode].fatal || results[mode].errors?.length > 0)
        ) {
          record.artifact = saveCase(item, results, comparison, noMemoComparison);
        }
        records.push(record);
        for (const { label, compared } of [
          { label: "default", compared: comparison },
          { label: "no-memo", compared: noMemoComparison },
        ]) {
          if (compared?.regressions.length > 0) {
            process.stderr.write(
              `[regression:${label}] ${item.id}: ${compared.regressions.join(", ")}\n  ${record.artifact}\n`,
            );
            for (const diagnostic of compared.addedDiagnostics) {
              process.stderr.write(`  ${diagnostic.message}\n`);
            }
          } else if (compared && !compared.complete) {
            process.stderr.write(`[incomplete:${label}] ${item.id}: ${record.artifact}\n`);
          }
        }
      }
    }
  }

  const notRun = items
    .filter((item) => !resultsById.has(item.id))
    .map((item) => ({
      id: item.id,
      reason: canary.passed ? "audit-budget-exhausted" : "canary-failed",
    }));
  let benchmark = { requested: settings.benchmark, complete: false };
  if (settings.benchmark && canary.passed && notRun.length === 0) {
    const excluded = [];
    const eligible = items.filter((item) => {
      const results = resultsById.get(item.id);
      const clean = ["off", "on"].every(
        (mode) =>
          results[mode].kind === "result"
          && !results[mode].fatal
          && results[mode].errors.length === 0,
      );
      const reason = !clean
        ? "diagnostics-or-failure"
        : item.bytes > settings.benchmarkMaxBytes
          ? "benchmark-max-bytes"
          : null;
      if (reason) excluded.push({ id: item.id, reason });
      return reason === null;
    });
    const sample = eligible
      .filter((item) => item.corpus !== "generated")
      .sort((a, b) => compare(sha256(a.id), sha256(b.id)))
      .slice(0, settings.sampleSize)
      .concat(eligible.filter((item) => item.corpus === "generated"))
      .sort((a, b) => compare(a.id, b.id));
    const selected = new Set(sample.map((item) => item.id));
    for (const item of eligible) {
      if (!selected.has(item.id)) excluded.push({ id: item.id, reason: "deterministic-sampling" });
    }
    benchmark = {
      ...benchmark,
      sample: sample.map((item) => ({
        id: item.id,
        inputSha256: item.inputSha256,
        configSha256: item.configSha256,
      })),
      excluded: excluded.sort((a, b) => compare(a.id, b.id)),
      warmups: settings.warmups,
      repetitions: settings.repetitions,
      units: "milliseconds inside transformSync, excluding load/IPC/hash/artifacts",
      order: "alternating off/on then on/off each round",
    };
    benchmark.sampleSha256 = sha256(stable(benchmark.sample));
    if (sample.length > 0) {
      const job = runChild(
        sample.map((item) => ({
          id: item.id,
          filename: item.filename,
          source: item.source,
          options: item.options,
          expected: Object.fromEntries(
            ["off", "on"].map((mode) => [mode, resultSignature(resultsById.get(item.id)[mode])]),
          ),
        })),
        ["off", "on"],
        settings.benchmarkBudgetMs,
        { warmups: settings.warmups, repetitions: settings.repetitions },
      );
      const measurement = job.messages.find((message) => message.type === "benchmark");
      const failure = job.messages.find((message) => message.type === "benchmark-failure");
      if (measurement && !job.failure && !failure) {
        benchmark.complete = true;
        benchmark.rounds = measurement.rounds;
        benchmark.offMs = distribution(measurement.rounds.map((round) => round.offMs));
        benchmark.onMs = distribution(measurement.rounds.map((round) => round.onMs));
        benchmark.pairedOnOffRatio = distribution(
          measurement.rounds.map((round) => round.onMs / round.offMs),
        );
      } else {
        benchmark.failure = failure ?? job.failure ?? { kind: "missing-benchmark-result" };
        writeJson(join(settings.artifacts, "benchmark-failure.json"), benchmark.failure);
      }
    } else benchmark.failure = { kind: "empty-benchmark-sample" };
  }

  if (compiler !== null) {
    try {
      const finalIdentity = compilerIdentity(
        settings.binding,
        compiler.binaries.map((binary) => binary.path),
        compiler.target,
      );
      if (compiler.sha256 !== finalIdentity.sha256) {
        infrastructure.push({
          kind: "compiler-changed-at-end",
          actual: finalIdentity.sha256,
          expected: compiler.sha256,
        });
      }
    } catch (error) {
      infrastructure.push({ kind: "compiler-fingerprint-error", message: error.message });
    }
  } else infrastructure.push({ kind: "no-native-fingerprint" });

  const configs = Object.fromEntries(
    [
      ...new Map(
        [canaryItem, ...items, ...skippedSources.filter((item) => item.options)].map((item) => [
          item.configSha256,
          {
            base: item.options,
            variants: Object.fromEntries(
              modesToAudit.map((mode) => [mode, optionsFor(item.options, mode)]),
            ),
          },
        ]),
      ).entries(),
    ].sort(([a], [b]) => compare(a, b)),
  );
  const unsupportedFeatures = Object.create(null);
  for (const item of [...items, ...skippedSources]) {
    for (const feature of item.pragmas?.unsupported ?? []) {
      const count = (unsupportedFeatures[feature.key] ??= { occurrences: 0, files: [] });
      count.occurrences++;
      if (!count.files.includes(item.id)) count.files.push(item.id);
    }
  }
  const regressions = records
    .filter(
      (record) =>
        record.comparison.regressions.length > 0 || record.noMemoComparison?.regressions.length > 0,
    )
    .map((record) => ({
      id: record.id,
      categories: record.comparison.regressions,
      noMemoCategories: record.noMemoComparison?.regressions ?? [],
      artifact: record.artifact,
    }));
  const changedOutputs = records
    .filter((record) => record.comparison.outputChanged)
    .map((record) => record.id);
  const changedDiagnostics = records
    .filter((record) => record.comparison.diagnosticsChanged)
    .map((record) => record.id);
  if (sha256(readFileSync(SCRIPT)) !== harnessSha256) {
    infrastructure.push({ kind: "audit-script-changed" });
  }
  const buildMetadataPath = join(dirname(settings.binding), "build-metadata.json");
  if (compiler && existsSync(buildMetadataPath)) {
    try {
      const text = readFileSync(buildMetadataPath, "utf8");
      compiler.buildMetadata = {
        path: buildMetadataPath,
        sha256: sha256(text),
        data: JSON.parse(text),
      };
      const expected = compiler.buildMetadata.data.binarySha256;
      if (
        typeof expected === "string"
        && !compiler.binaries.some((binary) => binary.sha256 === expected)
      ) {
        infrastructure.push({ kind: "build-metadata-binary-mismatch", expected });
      }
    } catch (error) {
      infrastructure.push({ kind: "build-metadata-error", message: error.message });
    }
  }
  const incomplete =
    infrastructure.length > 0
    || items.length === 0
    || notRun.length > 0
    || records.some(
      (record) =>
        !record.comparison.complete
        || (record.noMemoComparison && !record.noMemoComparison.complete),
    )
    || (settings.benchmark && !benchmark.complete);
  const noMemo = {
    requested: settings.noMemoDifferential,
    completeComparisons: records.filter((record) => record.noMemoComparison?.complete).length,
    changedOutputs: records
      .filter((record) => record.noMemoComparison?.outputChanged)
      .map((record) => record.id),
    changedDiagnostics: records
      .filter((record) => record.noMemoComparison?.diagnosticsChanged)
      .map((record) => record.id),
    addedDiagnostics: records.reduce(
      (sum, record) => sum + (record.noMemoComparison?.addedDiagnostics.length ?? 0),
      0,
    ),
    addedInvariants: records.reduce(
      (sum, record) => sum + (record.noMemoComparison?.addedInvariants.length ?? 0),
      0,
    ),
    newFatal: records.filter((record) => record.noMemoComparison?.regressions.includes("new-fatal"))
      .length,
    regressionFiles: records.filter((record) => record.noMemoComparison?.regressions.length > 0)
      .length,
  };
  const limited =
    skippedSources.length > 0
    || Object.keys(unsupportedFeatures).length > 0
    || corpora.some((corpus) => corpus.skippedEntries.length > 0)
    || workerFailures.length > 0;
  const status =
    !canary.passed || regressions.length > 0
      ? "regression"
      : incomplete
        ? "incomplete"
        : changedDiagnostics.length > 0 || noMemo.changedDiagnostics.length > 0
          ? "diagnostic-changes"
          : limited
            ? "no-new-compilation-failures-with-limitations"
            : "no-new-compilation-failures";
  const exitCode = status === "regression" ? 1 : incomplete ? 2 : 0;
  const report = {
    schemaVersion: 1,
    status,
    exitCode,
    scope:
      "Compile-only differential audit; changed text or cache counts are not evidence of semantic correctness or a semantic regression.",
    startedAt: new Date(start).toISOString(),
    durationMs: Date.now() - start,
    settings,
    harness: { path: SCRIPT, sha256: harnessSha256, revision: git(ROOT, ["rev-parse", "HEAD"]) },
    host: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
    },
    compiler,
    inputSha256: sha256(
      stable(
        [...items, ...skippedSources]
          .sort((a, b) => compare(a.id, b.id))
          .map((item) => ({
            id: item.id,
            rawSha256: item.rawSha256,
            inputSha256: item.inputSha256,
            configSha256: item.configSha256,
            skip: item.reason,
          })),
      ),
    ),
    configurationSha256: sha256(stable(configs)),
    configurations: configs,
    corpusProvenance: corpora.map(
      ({ items: _items, skippedSources: _skippedSources, ...corpus }) => corpus,
    ),
    configurationCoverage: {
      unsupportedFeatures,
      unsupportedFileCount: [...items, ...skippedSources].filter(
        (item) => item.pragmas?.unsupported.length > 0,
      ).length,
      snapshotEquivalenceClaimed: false,
      notes: [
        "Fixture inputs use TSX/module, compilationMode all, panicThreshold all_errors, preserved JSX, and normalized newlines.",
        "Additional corpora use filename-based parsing, compilationMode infer, panicThreshold none, and preserved JSX; application bundler configuration is not inferred.",
        "reportDiagnostics is always true; only the scheduling flag differs between variants.",
        "Unavailable test-only options/providers are counted per file; runner directives such as @skip do not omit compiler inputs.",
        "NAPI also performs semantic validation and TypeScript erasure. This is not the Rust snapshot runner or upstream runtime conformance.",
      ],
    },
    canary,
    summary: {
      sourceCandidates: corpora.reduce((sum, corpus) => sum + corpus.sourceCandidates, 0),
      generatedStressCases: items.filter((item) => item.corpus === "generated").length,
      selectedCases: items.length,
      attemptedCases: records.length,
      completeComparisons: records.filter((record) => record.comparison.complete).length,
      omittedEqualsFalse: records.filter((record) => record.comparison.defaultOffEqual).length,
      changedOutputs: changedOutputs.length,
      changedDiagnostics: changedDiagnostics.length,
      regressionFiles: regressions.length,
      addedDiagnostics: records.reduce(
        (sum, record) => sum + record.comparison.addedDiagnostics.length,
        0,
      ),
      addedInvariants: records.reduce(
        (sum, record) => sum + record.comparison.addedInvariants.length,
        0,
      ),
      newFatal: records.filter((record) => record.comparison.regressions.includes("new-fatal"))
        .length,
      inheritedDiagnosticOrFatalFiles: records.filter((record) =>
        record.comparison.categories.includes("inherited-diagnostics-or-fatal"),
      ).length,
      skippedSources: skippedSources.length,
      skippedEntries: corpora.reduce((sum, corpus) => sum + corpus.skippedEntries.length, 0),
      notRun: notRun.length,
      workerCount,
      workerFailures: workerFailures.length,
    },
    changedOutputs,
    changedDiagnostics,
    regressions,
    skippedSources,
    notRun,
    infrastructure,
    workerFailures,
    noMemo,
    benchmark,
    files: records,
  };
  writeJson(settings.output, report);
  writeFileSync(
    join(settings.artifacts, "changed-outputs.txt"),
    changedOutputs.length > 0 ? `${changedOutputs.join("\n")}\n` : "",
  );
  writeFileSync(
    join(settings.artifacts, "changed-diagnostics.txt"),
    changedDiagnostics.length > 0 ? `${changedDiagnostics.join("\n")}\n` : "",
  );
  if (settings.noMemoDifferential) {
    writeFileSync(
      join(settings.artifacts, "no-memo-changed-outputs.txt"),
      noMemo.changedOutputs.length > 0 ? `${noMemo.changedOutputs.join("\n")}\n` : "",
    );
    writeFileSync(
      join(settings.artifacts, "no-memo-changed-diagnostics.txt"),
      noMemo.changedDiagnostics.length > 0 ? `${noMemo.changedDiagnostics.join("\n")}\n` : "",
    );
    process.stdout.write(
      `M0/M1: ${noMemo.completeComparisons} comparisons; ${noMemo.changedDiagnostics.length} changed diagnostics; ${noMemo.regressionFiles} regression files.\n`,
    );
  }
  process.stdout.write(
    `${status}: ${report.summary.completeComparisons}/${items.length} comparisons; ${changedOutputs.length} changed outputs; ${changedDiagnostics.length} changed diagnostics; ${regressions.length} regression files.\n`,
  );
  process.stdout.write(
    `Canary: ${canary.passed ? "passed" : "FAILED"}; skipped source files: ${skippedSources.length}; unsupported configuration files: ${report.configurationCoverage.unsupportedFileCount}.\n`,
  );
  if (benchmark.complete) {
    process.stdout.write(
      `Benchmark paired on/off ratio: median ${benchmark.pairedOnOffRatio.median.toFixed(3)}, p95 ${benchmark.pairedOnOffRatio.p95.toFixed(3)} (${benchmark.repetitions} repetitions).\n`,
    );
  }
  process.stdout.write(
    `Compile-only; not semantic proof. Report: ${settings.output}\nArtifacts: ${settings.artifacts}\n`,
  );
  return exitCode;
}

if (process.argv[2] === "--worker") {
  await worker();
} else {
  try {
    const settings = parseArgs(process.argv.slice(2));
    if (settings === null) process.stdout.write(usage());
    else process.exitCode = runAudit(settings);
  } catch (error) {
    process.stderr.write(`Corpus audit failed: ${error.stack ?? error}\n`);
    process.exitCode = 2;
  }
}
