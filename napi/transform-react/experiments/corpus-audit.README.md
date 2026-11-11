# Instruction-scheduling corpus audit

`corpus-audit.mjs` compares the native `transformSync` API with
`reactCompiler.environment.enableInstructionReordering` **omitted**, **false**,
and **true**. It needs Node.js 20.19+ and an already-built native binding; it has
no package dependencies and does not build the compiler.

This is a **compile-only audit, not semantic proof**. It never executes fixture
entrypoints, components, hooks, or generated JavaScript. A textual change, a
removed diagnostic, or a cache-size change does not establish correct runtime
behavior. Runtime equivalence requires independent testing.

## Run

From the repository root:

```sh
node napi/transform-react/experiments/corpus-audit.mjs \
  --binding /absolute/path/to/napi/transform-react/index.js \
  --output /absolute/path/to/results/audit.json \
  --artifacts /absolute/path/to/results/artifacts
```

By default, the corpus is this checkout's entire
`crates/oxc_react_compiler/fixtures` tree. To audit a newer checkout's fixtures
and add a public application corpus:

```sh
node napi/transform-react/experiments/corpus-audit.mjs \
  --binding /absolute/path/to/immutable-binding/index.js \
  --fixtures /absolute/path/to/oxc/crates/oxc_react_compiler/fixtures \
  --corpus /absolute/path/to/App/src \
  --no-memo-differential \
  --output /absolute/path/to/results/audit.json \
  --artifacts /absolute/path/to/results/artifacts
```

`--corpus` is repeatable. `--no-fixtures` selects application/stress inputs only.
`--filter TEXT` selects paths containing the literal substring, with every
excluded source counted. `--help` lists all options and limits.

Use a stable binding artifact. Each child reports the SHA-256 of the loader and
the **actually loaded `.node` binaries**, not a guessed sibling filename. A
different fingerprint within a run invalidates the audit. Adjacent
`build-metadata.json`, when present, is recorded; its `binarySha256` must agree
with a loaded native artifact. WASI and JavaScript-only bindings are rejected.

## Checks and outcomes

- Omitted and explicit false must have identical code, diagnostics (including
  source spans/codeframes), and fatality for every compared input.
- The enabled run must not add any diagnostic, become fatal, throw, crash, or
  hang. Diagnostic comparison uses multisets, so even an extra duplicate counts.
  Reordered diagnostics and removals are reported separately.
- Invariant additions are also counted explicitly using the native diagnostic
  category in the codeframe, with a message fallback. Every added diagnostic is
  blocking regardless of that classification.
- Existing baseline diagnostics/fatal results are expected corpus outcomes.
  Unchanged failures are recorded; they are not new regressions. Inherited
  process crashes, timeouts, and exceptions leave comparisons incomplete.
- A mandatory synthetic canary has a literal allocation, an intervening hook,
  and a later mutation. Default/off must emit no memo cache; enabled must sink
  the allocation past the hook and emit a cache without diagnostics. An old
  binding that silently ignores the flag cannot pass.
- With `--no-memo-differential`, **M0** (`noMemoOff`) and **M1** (`noMemoOn`) both
  set `disableMemoizationForTesting: true`. Their only difference is scheduling.
  Their diagnostics, failures, and changed-output lists are reported separately
  and feed the overall regression gate. The canary also checks that this native
  test mode is recognized. Benchmark mode measures the ordinary off/on pair.

Exit codes:

| Code | Meaning                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | Complete comparisons within the reported coverage; no added failures/diagnostics. Diagnostic removals and coverage limitations remain visible in the status. |
| `1`  | Regression or failed canary.                                                                                                                                 |
| `2`  | Empty/incomplete audit, requested benchmark incomplete, or infrastructure error.                                                                             |

A zero-input run cannot pass, even if the canary passes. Successful compilation
means the transform API returned; it does not imply every function was optimized.

## Configuration coverage

Fixture defaults follow the Rust snapshot runner where NAPI permits:

- TSX/module parsing regardless of extension; `@script` changes the source type.
- `compilationMode: "all"`, `panicThreshold: "all_errors"`.
- `validatePreserveExistingMemoizationGuarantees` defaults to false and becomes
  true on first-line pragma presence, including `:false`, matching the snapshot
  runner's presence-based override.
- CRLF/CR normalization, preserved JSX, and `reportDiagnostics: true`.

The adapter reads **first-line `//` pragmas only**. It supports exposed boolean
environment flags, compiler mode/panic/output/target enums, string-list options,
gating test defaults, dynamic gating, simple macros, and the JSX/experimental
effect-validation spelling aliases. Enum values can be JSON strings or bare
enum names. Other values must be JSON; strings containing `@` are preserved.
The scheduling flag is controlled by the audit, not by fixture pragmas.

Unavailable test-only options, unsupported values/syntax, dotted macro paths,
and references to the snapshot runner's magic module-type providers are listed
per file and aggregated by feature. Those files still run with the supported
configuration subset. `@skip`, `@expectNothingCompiled`, `@Pass`, `@debug`, and
`@xonly` are recorded as runner metadata; they do not skip the compilation audit.
Flow-marked files are explicitly skipped because NAPI cannot parse Flow.

Additional application corpora use filename-based parsing and native defaults
(`compilationMode: "infer"`, `panicThreshold: "none"`), with preserved JSX and
diagnostic reporting enabled. Application compiler pragmas and bundler settings
are not inferred. Only the scheduler flag differs within each comparison.

NAPI additionally performs semantic validation and TypeScript erasure. Its
results are **not claimed to reproduce the Rust snapshots or upstream fixture
runner**. Unsupported-configuration counts describe the adapter, not feature
support in every possible native compiler version.

## Isolation and budgets

All native code runs in child processes, including the canary. The default
chunk has at most 32 files and 8 MiB of source; `--chunk-size` adjusts its file
limit. A chunk has a 15-second hard timeout. Completed variant results are
preserved if a child fails; missing variants are retried in individual children
with a 5-second timeout. A failure in the off variant cannot hide the on variant.
Child failures and last-started file/mode are retained as artifacts. Recovered
chunk failures remain visible as coverage limitations.

The default whole-run budget is 180 seconds. Native children receive the smaller
of their timeout and the remaining budget; timeout termination uses `SIGKILL`.
`--budget-ms`, `--timeout-ms`, and `--single-timeout-ms` adjust these limits.
Each child has a 64 MiB captured-output limit. Files larger than
`--max-file-bytes` (default 1 MiB), declaration files, and filtered/Flow files
have explicit skip records. Symlinks are not followed; `node_modules`, `.git`,
and the artifact directory are excluded, with excluded directory entries counted
without pretending to enumerate their descendants.

## Compile-time sampling and stress inputs

```sh
node napi/transform-react/experiments/corpus-audit.mjs \
  --binding /absolute/path/to/immutable-binding/index.js \
  --benchmark --sample-size 64 --warmups 2 --repetitions 8 \
  --stress-size 128 \
  --output /absolute/path/to/results/benchmark.json
```

The benchmark deterministically chooses clean off/on cases by the SHA-256 of
their corpus-relative IDs. The selected IDs, source/config hashes, sample hash,
and every exclusion reason are recorded. Eligible generated stress cases are
included in addition to the sampled corpus files. Inputs larger than
`--benchmark-max-bytes` (default 32 KiB) are excluded explicitly.

Warmup and measured rounds alternate off/on and on/off in the same child.
Timings cover `transformSync` and result access, excluding binding load, file
I/O, IPC, cloning, hashing, and artifact writing. Every result is checked against
its audit hash outside the measured interval; nondeterministic results fail the
benchmark. Reports retain raw per-file/per-round timings and min, median, p90,
p95, max, mean, and standard deviation for each mode and the paired on/off ratio.
These are local measurements, not a cross-machine performance guarantee.

`--stress-size N` adds two in-memory sources: a dependent inert array chain and
many independent array allocations crossing a hook. The count is bounded at
2,048; the default is zero. Hard timeouts and benchmark size limits also apply. The
benchmark child has a separate default 30-second budget, adjustable with
`--benchmark-budget-ms`. Use small counts first for potentially quadratic paths.

## Evidence and source provenance

The JSON report contains deterministic relative-path ordering, raw/normalized
input hashes, base and per-variant config hashes, harness/compiler fingerprints,
corpus revisions, per-file diagnostics, skip counts, and changed-output lists.
Wall-clock metadata, timings, and absolute local paths naturally vary by run.

`cases/<ID hash>/` stores the compiled input, all variant options/outputs, and
full results whenever outputs/diagnostics change or a variant fails/reports a
diagnostic. The canary always has artifacts. `changed-outputs.txt` and
`changed-diagnostics.txt` provide plain path lists, with separate no-memo lists
when requested. Worker stderr/stdout and benchmark failures have their own files.

Corpus-level license files and per-source copyright/SPDX notices are recorded
without changing ownership. Oxc's React Compiler fixtures carry the crate's MIT
license and Meta/VoidZero copyright notices; application inputs retain their own
license and notices. Reports and artifacts are local outputs and are never
uploaded. Public documentation for this tool contains no copied corpus source;
only public fixtures/App inputs should be excerpted in public follow-up reports.

This audit tooling was authored with AI assistance.
