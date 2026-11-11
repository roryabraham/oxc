/* oxlint-disable no-console -- This CLI reports its URL, native provenance, and results. */
/* oxlint-disable no-await-in-loop -- Persist each native result before compiling the next fixture. */
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build, version as esbuildVersion } from "esbuild";
import { modes, profiles, scenarios } from "./catalog.mjs";
import { NativeCompiler } from "./native-client.mjs";
import { structuralEvidence } from "./structure.mjs";
import { BrowserWatchdog } from "./watchdog.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { values } = parseArgs({
  options: {
    binding: { type: "string" },
    output: { type: "string" },
    port: { type: "string", default: "41783" },
    "build-only": { type: "boolean", default: false },
    "keep-open": { type: "boolean", default: false },
    "compile-timeout-ms": { type: "string", default: "10000" },
    "cell-timeout-ms": { type: "string", default: "15000" },
    "browser-timeout-ms": { type: "string", default: "120000" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(`Usage: node cli.mjs --binding /absolute/path/index.js --output /artifact/directory
  --port 41783    Dedicated loopback port; open the printed URL in a real browser.
  --build-only    Compile and bundle; explicitly report that browser tests did not run.
  --keep-open     Keep the HTTP server available after persisting results.
  --compile-timeout-ms 10000   Per native worker operation, including binding load.
  --cell-timeout-ms 15000      External per-cell browser watchdog.
  --browser-timeout-ms 120000  External total browser/server deadline, including startup.

The default run exits after the browser posts results. Exit 0 requires every cell
and invariant to pass. All runtime files are bundled locally; no CDN is used.`);
} else {
  if (!values.binding || !values.output) throw new Error("--binding and --output are required");
  const output = path.resolve(values.output);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error("--output must be an empty directory");
  try {
    const manifest = await prepare(output);
    if (values["build-only"]) {
      console.log(
        JSON.stringify(
          {
            status: "browser-not-run",
            output,
            compile: manifest.compileCounts,
            canary: manifest.canary,
          },
          null,
          2,
        ),
      );
      if (manifest.compileCounts.failed) process.exitCode = 1;
    } else {
      await serve(output, manifest);
    }
  } catch (error) {
    await saveJson(path.join(output, "fatal-error.json"), serializeError(error));
    console.error(error);
    process.exitCode = 1;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(file) {
  return sha256(await readFile(file));
}

async function saveJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function serializeError(error) {
  return {
    name: error?.name,
    message: error?.message ?? String(error),
    stack: error?.stack,
    details: error?.details,
  };
}

function optionsFor(mode) {
  return {
    lang: "jsx",
    sourceType: "module",
    jsx: "preserve",
    reactCompiler: mode.compiler
      ? {
          compilationMode: "annotation",
          target: "19",
          reportDiagnostics: true,
          environment: {
            enableInstructionReordering: mode.reorder,
            disableMemoizationForTesting: mode.noMemo,
          },
        }
      : false,
  };
}

function timeout(name) {
  const milliseconds = Number(values[name]);
  if (!Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > 3600000) {
    throw new Error(`--${name} must be an integer between 1 and 3600000`);
  }
  return milliseconds;
}

async function prepare(output) {
  await saveJson(path.join(output, "native-progress.json"), {
    stage: "native-load",
    binding: path.resolve(values.binding),
  });
  const compiler = new NativeCompiler(path.resolve(values.binding), timeout("compile-timeout-ms"));
  try {
    const native = await compiler.ready;
    const manifest = {
      schemaVersion: 1,
      runId: randomUUID(),
      createdAt: new Date().toISOString(),
      native,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      dependencies: {
        react: require("react/package.json").version,
        reactDom: require("react-dom/package.json").version,
        esbuild: esbuildVersion,
        acorn: require("acorn/package.json").version,
        acornJsx: require("acorn-jsx/package.json").version,
      },
      modes,
      profiles,
      scenarios,
      deadlines: {
        nativeOperationMs: timeout("compile-timeout-ms"),
        browserCellMs: timeout("cell-timeout-ms"),
        browserTotalMs: timeout("browser-timeout-ms"),
      },
      records: [],
      validationStatus: "compiling",
    };
    await mkdir(path.join(output, "sources"));
    await mkdir(path.join(output, "compiled"));
    await mkdir(path.join(output, "failures"));
    await saveJson(path.join(output, "manifest.json"), manifest);
    const fixtureNames = [...new Set(scenarios.map((scenario) => scenario.fixture))];
    for (const fixture of fixtureNames) {
      const filename = `${fixture}.jsx`;
      const source = await readFile(path.join(directory, "fixtures", filename), "utf8");
      await writeFile(path.join(output, "sources", filename), source);
      for (const mode of modes) {
        const record = await compile(compiler, fixture, mode.id, source, optionsFor(mode), output);
        const expectsCache = mode.compiler && !mode.noMemo;
        const hasCache = record.code.includes("react/compiler-runtime");
        if (!record.errors.length && hasCache !== expectsCache) {
          record.errors.push({
            message: `Expected compiler cache emission=${expectsCache}, got ${hasCache}; refusing silent fallback`,
          });
        }
        record.status =
          record.errors.length || record.fatal || !record.code ? "compile-error" : "compiled";
        record.sourceFile = `sources/${filename}`;
        record.codeFile = `compiled/${fixture}.${mode.id}.jsx`;
        await writeFile(path.join(output, record.codeFile), record.code);
        await saveJson(path.join(output, "compiled", `${fixture}.${mode.id}.json`), {
          ...record,
          native,
        });
        manifest.records.push(record);
      }
    }
    const baseline = manifest.records.find(
      (record) => record.fixture === "canary" && record.mode === "B",
    );
    const defaultOptions = optionsFor(modes[1]);
    delete defaultOptions.reactCompiler.environment;
    const defaultRecord = await compile(
      compiler,
      "canary",
      "defaults",
      baseline.source,
      defaultOptions,
      output,
    );
    defaultRecord.status =
      !defaultRecord.errors.length && !defaultRecord.fatal && defaultRecord.code
        ? "compiled"
        : "compile-error";
    defaultRecord.sourceFile = "sources/canary.jsx";
    defaultRecord.codeFile = "compiled/canary.defaults.jsx";
    await writeFile(path.join(output, defaultRecord.codeFile), defaultRecord.code);
    await saveJson(path.join(output, "compiled", "canary.defaults.json"), {
      ...defaultRecord,
      native,
    });
    manifest.records.push(defaultRecord);
    manifest.compileCounts = {
      total: manifest.records.length,
      compiled: manifest.records.filter((record) => record.status === "compiled").length,
      failed: manifest.records.filter((record) => record.status !== "compiled").length,
      diagnostics: manifest.records.reduce((count, record) => count + record.errors.length, 0),
    };
    manifest.validationStatus = "browser-not-run";
    await saveJson(path.join(output, "native-progress.json"), {
      stage: "complete",
      compileCounts: manifest.compileCounts,
      native,
    });
    manifest.canary = canaryEvidence(manifest.records);
    manifest.structure = structuralEvidence(manifest.records);
    manifest.schedulingEmission = Object.fromEntries(
      fixtureNames.map((fixture) => {
        const code = (mode) =>
          manifest.records.find((record) => record.fixture === fixture && record.mode === mode)
            .code;
        return [
          fixture,
          {
            memoizedOutputIdentical: code("B") === code("S"),
            noMemoOutputIdentical: code("M0") === code("M1"),
            suspensionMotionVerified: fixture === "transition-motion" && manifest.structure.passed,
          },
        ];
      }),
    );
    await saveJson(path.join(output, "manifest.json"), manifest);
    if (!manifest.canary.passed) {
      const error = new Error(
        "Positive motion/cache/default-flag canary failed; browser run refused",
      );
      error.details = manifest.canary;
      throw error;
    }
    if (!manifest.structure.passed) {
      const error = new Error(
        "Emitted hook-order or concurrent-motion structural gate failed; browser run refused",
      );
      error.details = manifest.structure;
      throw error;
    }
    if ((await hashFile(native.binary)) !== native.binarySha256) {
      throw new Error("Native artifact changed during compilation");
    }
    const imports = [
      `import { run } from ${JSON.stringify(path.join(directory, "browser/suite.mjs"))};`,
    ];
    const registry = {};
    for (const fixture of fixtureNames) {
      registry[fixture] = {};
      for (const mode of modes) {
        const record = manifest.records.find(
          (item) => item.fixture === fixture && item.mode === mode.id,
        );
        const name = `${fixture.replaceAll("-", "_")}_${mode.id}`;
        if (record.status === "compiled") {
          imports.push(
            `import { Component as ${name} } from ${JSON.stringify(`./${record.codeFile}`)};`,
          );
          registry[fixture][mode.id] = `{ Component: ${name}, errors: [] }`;
        } else {
          registry[fixture][mode.id] =
            `{ Component: null, errors: ${JSON.stringify(record.errors)} }`;
        }
      }
    }
    const registryText = `{${Object.entries(registry)
      .map(
        ([fixture, entries]) =>
          `${JSON.stringify(fixture)}: {${Object.entries(entries)
            .map(([mode, value]) => `${JSON.stringify(mode)}: ${value}`)
            .join(",")}}`,
      )
      .join(",")}}`;
    const metadata = {
      runId: manifest.runId,
      native,
      canary: manifest.canary,
      structure: manifest.structure,
      schedulingEmission: manifest.schedulingEmission,
      deadlines: manifest.deadlines,
      compileCounts: manifest.compileCounts,
    };
    const entry = `${imports.join("\n")}
window.__schedulingDone = run(${registryText}, ${JSON.stringify(metadata)}).catch(async error => {
  const failure = { status: 'fatal', message: error.message, stack: error.stack };
  window.__schedulingResults = failure;
  document.getElementById('status').textContent = JSON.stringify(failure, null, 2);
  await fetch('/fatal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(failure) });
  return failure;
});\n`;
    await writeFile(path.join(output, "entry.mjs"), entry);
    const bundle = await build({
      entryPoints: [path.join(output, "entry.mjs")],
      outfile: path.join(output, "bundle.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"' },
      sourcemap: "external",
      metafile: true,
      nodePaths: [path.join(directory, "node_modules")],
      alias: { "@harness/runtime": path.join(directory, "browser/runtime.jsx") },
      logLevel: "silent",
    });
    if (bundle.warnings.length) {
      throw new Error(`Unexpected bundler warnings: ${JSON.stringify(bundle.warnings)}`);
    }
    manifest.bundleSha256 = await hashFile(path.join(output, "bundle.js"));
    const browserRunner = await readFile(path.join(directory, "browser-runner.mjs"), "utf8");
    manifest.browserRunnerSha256 = sha256(browserRunner);
    await writeFile(
      path.join(output, "playwright-run.js"),
      `async (page) => {
${browserRunner.replace("export async function runBrowser", "async function runBrowser")}
const report = await runBrowser(page, ${JSON.stringify(`http://127.0.0.1:${values.port}/`)}, { timeoutMs: ${manifest.deadlines.browserTotalMs + 5000} });
return { status: report.status, counts: report.counts, native: report.metadata?.native.binarySha256,
  structuralGatesPassed: report.metadata?.structure.passed,
  failures: report.results?.filter(result => result.status !== 'pass'),
  browserErrors: report.browserErrors, consoleMessages: report.consoleMessages };
}\n`,
    );
    await saveJson(path.join(output, "bundle-metafile.json"), bundle.metafile);
    await saveJson(path.join(output, "manifest.json"), manifest);
    await writeFile(
      path.join(output, "index.html"),
      `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OXC browser scheduling experiment</title>
<link rel="icon" href="data:,"></head><body>
<h1>OXC browser scheduling experiment</h1><pre id="status">Starting real React DOM tests…</pre>
<a id="download" download="scheduling-results.json" hidden>Download results</a><div id="mounts"></div>
<script type="module" src="/bundle.js"></script></body></html>\n`,
    );
    return manifest;
  } finally {
    await compiler.stop();
  }
}

async function compile(compiler, fixture, mode, source, options, output) {
  await saveJson(path.join(output, "native-progress.json"), {
    stage: "native-compile",
    fixture,
    mode,
    source,
    options,
    native: compiler.native,
  });
  const result = await compiler.transform(fixture, mode, source, options);
  return {
    fixture,
    mode,
    source,
    sourceSha256: sha256(source),
    options,
    fatal: result.fatal,
    errors: result.errors,
    code: result.code,
    codeSha256: sha256(result.code),
  };
}

function canaryEvidence(records) {
  const byMode = Object.fromEntries(
    records.filter((record) => record.fixture === "canary").map((record) => [record.mode, record]),
  );
  const positions = Object.fromEntries(
    ["B", "S", "M0", "M1"].map((mode) => {
      const { code } = byMode[mode];
      return [
        mode,
        {
          allocation: code.indexOf('[value, "before"]'),
          hook: code.indexOf("useState(7)"),
          cacheRuntime: code.includes("react/compiler-runtime"),
        },
      ];
    }),
  );
  const gates = {
    diagnosticFree: Object.values(byMode).every((record) => record.status === "compiled"),
    flagsDefaultOff: byMode.defaults.code === byMode.B.code,
    baselineAllocationBeforeHook:
      positions.B.allocation >= 0 && positions.B.allocation < positions.B.hook,
    scheduledAllocationAfterHook:
      positions.S.hook >= 0 && positions.S.allocation > positions.S.hook,
    noMemoBaselineAllocationBeforeHook:
      positions.M0.allocation >= 0 && positions.M0.allocation < positions.M0.hook,
    noMemoScheduledAllocationAfterHook:
      positions.M1.hook >= 0 && positions.M1.allocation > positions.M1.hook,
    compiledCaches: positions.B.cacheRuntime && positions.S.cacheRuntime,
    noMemoCachesDisabled: !positions.M0.cacheRuntime && !positions.M1.cacheRuntime,
    uncompiledCacheDisabled: !byMode.U.code.includes("react/compiler-runtime"),
  };
  return { passed: Object.values(gates).every(Boolean), gates, positions };
}

async function serve(output, manifest) {
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("--port must be an integer between 1024 and 65535");
  }
  let received = false;
  const watchdog = new BrowserWatchdog({
    totalMs: manifest.deadlines.browserTotalMs,
    cellMs: manifest.deadlines.browserCellMs,
    onTimeout: async (failure) => {
      received = true;
      process.exitCode = 1;
      try {
        const report = enrichFailure({ ...failure, results: watchdog.completed }, manifest);
        report.activeCompilation =
          manifest.records.find(
            (record) =>
              record.fixture === failure.activeCell?.fixture
              && record.mode === failure.activeCell?.mode,
          ) ?? null;
        await saveJson(path.join(output, "watchdog-error.json"), report);
        await saveJson(path.join(output, "partial-results.json"), watchdog.completed);
        await saveJson(path.join(output, "summary.json"), {
          ...failure,
          native: manifest.native,
          counts: {
            planned: scenarios.length * profiles.length * modes.length,
            completed: watchdog.completed.length,
            passed: watchdog.completed.filter((result) => result.status === "pass").length,
            failed: watchdog.completed.filter((result) => result.status === "fail").length,
            compileErrors: watchdog.completed.filter((result) => result.status === "compile-error")
              .length,
          },
        });
        manifest.validationStatus = "timeout";
        await saveJson(path.join(output, "manifest.json"), manifest);
        console.error(`BROWSER WATCHDOG: ${JSON.stringify(failure)}`);
      } finally {
        server.closeAllConnections();
        server.close();
      }
    },
  });
  const server = createServer(async (request, response) => {
    try {
      const { pathname } = new URL(request.url, `http://127.0.0.1:${port}`);
      if (
        request.method === "POST"
        && ["/results", "/counterexample", "/fatal", "/progress", "/cell-result"].includes(pathname)
      ) {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) throw new Error("Browser report exceeds 32 MiB");
          chunks.push(chunk);
        }
        const report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (received) {
          throw new Error("This run has already terminated or persisted its browser report");
        }
        if (pathname === "/progress" || pathname === "/cell-result") {
          if (report.runId !== manifest.runId) {
            throw new Error("Browser progress belongs to a different build");
          }
          if (pathname === "/progress") {
            const { scenario, fixture, profile, mode } = report.cell;
            if (
              !scenarios.some((item) => item.id === scenario && item.fixture === fixture)
              || !profiles.some((item) => item.id === profile)
              || !modes.some((item) => item.id === mode)
            ) {
              throw new Error("Unknown browser cell");
            }
            watchdog.begin({ scenario, fixture, profile, mode });
          } else {
            watchdog.complete(report.result);
            await appendFile(
              path.join(output, "cells.ndjson"),
              `${JSON.stringify(report.result)}\n`,
            );
          }
          await saveJson(path.join(output, "progress.json"), watchdog.snapshot());
        } else if (pathname === "/counterexample") {
          const filename = `${report.group.scenario}.${report.group.profile}.counterexample.json`;
          await saveJson(path.join(output, "failures", filename), enrichFailure(report, manifest));
          console.error(`SCHEDULER COUNTEREXAMPLE: ${JSON.stringify(report.group)}`);
        } else {
          watchdog.stop();
          received = true;
          if (pathname === "/fatal") {
            await saveJson(path.join(output, "browser-fatal.json"), {
              ...report,
              native: manifest.native,
            });
            process.exitCode = 1;
          } else {
            if (report.metadata?.runId !== manifest.runId) {
              throw new Error("Browser report belongs to a different build");
            }
            if (report.results.length !== watchdog.completed.length || watchdog.activeCell) {
              throw new Error("Final browser results disagree with completed cell reports");
            }
            report.nativeArtifactUnchanged =
              (await hashFile(manifest.native.binary)) === manifest.native.binarySha256;
            if (!report.nativeArtifactUnchanged) report.status = "fail";
            await saveJson(path.join(output, "results.json"), report);
            for (const result of report.results.filter((item) => item.status !== "pass")) {
              await saveJson(
                path.join(
                  output,
                  "failures",
                  `${result.scenario}.${result.profile}.${result.mode}.json`,
                ),
                enrichFailure({ results: [result] }, manifest),
              );
            }
            await saveJson(path.join(output, "summary.json"), {
              status: report.status,
              environment: report.environment,
              native: manifest.native,
              compileCounts: manifest.compileCounts,
              canary: manifest.canary,
              structure: manifest.structure,
              schedulingEmission: manifest.schedulingEmission,
              deadlines: manifest.deadlines,
              counts: report.counts,
              groups: report.groups,
              browserErrors: report.browserErrors,
              consoleMessages: report.consoleMessages,
            });
            manifest.validationStatus = report.status;
            await saveJson(path.join(output, "manifest.json"), manifest);
            console.log(
              JSON.stringify({ status: report.status, output, ...report.counts }, null, 2),
            );
            process.exitCode = report.status === "pass" ? 0 : 1;
          }
          if (!values["keep-open"]) response.once("finish", () => server.close());
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"saved":true}');
        return;
      }
      const files = {
        "/": ["index.html", "text/html"],
        "/bundle.js": ["bundle.js", "text/javascript"],
        "/bundle.js.map": ["bundle.js.map", "application/json"],
        "/results.json": ["results.json", "application/json"],
      };
      if (request.method !== "GET" || !files[pathname]) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      const [file, type] = files[pathname];
      const body = await readFile(path.join(output, file));
      response.writeHead(200, {
        "Content-Type": `${type}; charset=utf-8`,
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:",
      });
      response.end(body);
    } catch (error) {
      watchdog.stop();
      await saveJson(path.join(output, "server-error.json"), {
        error: serializeError(error),
        native: manifest.native,
      });
      process.exitCode = 1;
      response.writeHead(500);
      response.end(error.message);
      server.close();
    }
  });
  server.once("close", () => watchdog.stop());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  watchdog.start();
  console.log(`Browser URL: http://127.0.0.1:${port}/`);
  console.log(`Native SHA256: ${manifest.native.binarySha256}`);
  console.log(`Artifacts: ${output}`);
  console.log(
    `Watchdogs: native=${manifest.deadlines.nativeOperationMs}ms, cell=${manifest.deadlines.browserCellMs}ms, total=${manifest.deadlines.browserTotalMs}ms`,
  );
  await new Promise((resolve) => server.once("close", resolve));
}

function enrichFailure(report, manifest) {
  return {
    ...report,
    native: manifest.native,
    canary: manifest.canary,
    structure: manifest.structure,
    compilation: (report.results ?? []).map((result) =>
      manifest.records.find(
        (record) => record.fixture === result.fixture && record.mode === result.mode,
      ),
    ),
  };
}
