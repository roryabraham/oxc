# Browser instruction-scheduling experiment

A standalone correctness suite for the experimental OXC React Compiler scheduler.
It compiles fixtures with a supplied **native** binding, bundles React/ReactDOM
**19.2.3** with esbuild **0.25.12**, and mounts actual components with `createRoot`
in a real browser. Runtime assets are entirely local. Results cover correctness;
the suite collects no latency or throughput measurements.

## Reproduce

From this directory, install the locked dependencies once:

```sh
npm ci --workspaces=false --no-audit --no-fund
npm run check --workspaces=false
node cli.mjs \
  --binding /absolute/path/to/napi/transform-react/index.js \
  --output artifacts/run \
  --port 41783
```

Use a native binding that implements `enableInstructionReordering` and
`disableMemoizationForTesting`. An immutable binding directory with an adjacent
`build-metadata.json` is preferable when another process is rebuilding OXC.
The CLI records the actual loaded `.node` file's SHA-256 and verifies it is
unchanged after the browser run. Environment variables overriding NAPI loading
are rejected. It never builds Rust or modifies the supplied binding.

Open the printed URL, `http://127.0.0.1:41783/`, in a real browser. The suite starts
automatically, downloads no runtime dependencies, and posts its report to the
local CLI. The CLI persists artifacts and exits **0 only when the entire run
passes**. A new run requires an empty output directory. `--keep-open` retains the
server after the report; `--build-only` explicitly reports `browser-not-run`.

Existing Playwright installations or an agent's private Playwright browser can
drive the page without adding a browser dependency to this package:

```js
await page.goto("http://127.0.0.1:41783/");
const report = await page.evaluate(() => window.__schedulingDone);
console.log(report.status, report.counts);
if (report.status !== "pass") throw new Error("Browser scheduling suite failed");
```

The page also exposes `window.__schedulingResults` and a **Download results** link.
Use `window.__schedulingDone` to await persistence. No sleeps or polling are needed.

## Matrix and fail-closed canary

| Mode | React Compiler | Instruction reordering | Disable compiler memoization |
| ---- | -------------- | ---------------------- | ---------------------------- |
| U    | `false`        | —                      | —                            |
| B    | enabled        | `false`                | `false`                      |
| S    | enabled        | `true`                 | `false`                      |
| M0   | enabled        | `false`                | `true`                       |
| M1   | enabled        | `true`                 | `true`                       |

All compiled modes use the same binding, `target: '19'`, annotation compilation,
`reportDiagnostics: true`, and JSX-preserving transform configuration. U uses
the same native parse/codegen pipeline with `reactCompiler: false`. esbuild
lowers JSX uniformly afterward. The M0/M1 pair isolates instruction motion from
compiler memoization; explicit `useMemo`/`useCallback` contracts remain tested.

Every fixture must have zero diagnostics. B/S must actually emit compiler caches,
and U/M0/M1 must not emit them. A failing fixture is a `compile-error` cell and is
never executed through an uncompiled fallback.

Before serving, a positive canary verifies:

- The default flag configuration emits exactly the explicit B output.
- A specific pure array allocation appears before `useState(7)` in B/M0 and
  after that hook in S/M1. Merely different generated text is insufficient.
- B/S emit compiler caches and M0/M1 do not.

The browser then verifies actual allocation identity across committed prop/state
updates: cached in B/S, fresh in U/M0/M1, and correctly invalidated by a changed
dependency in every mode. An ignored or inert scheduling flag fails the canary.

Both development profiles run by default: ordinary roots and root-level
`<StrictMode>`. **12 scenarios × 5 modes × 2 profiles = 120 runtime cells**, plus
46 native compilation checks (nine fixture modules and a default-flags canary).
Production runtime coverage is not part of the reported matrix.

## Scenarios

| Scenario                      | Explicit committed invariant                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Motion/cache canary           | State updates preserve the right caches; changed dependencies replace them.                                                                   |
| State callsite order          | Two distinct `useState` callsites independently handle 24 alternating DOM events, retained captured setters, and retained functional setters. |
| Retained allocations/handlers | Arrays, object aliases, helper arrays, and current/retained closures keep their committed values through eight prop/state revisions.          |
| Layout/passive resources      | Computed object dependencies capture committed data; both kinds pair every setup with one cleanup and leak nothing.                           |
| Transition resume/urgent      | A committed pending transition retains content while sibling and local urgent updates commit, then resolves with current state.               |
| Transition abandon            | An urgent replacement wins; resolving a superseded suspended transition never commits stale content.                                          |
| Initial Suspense/retry        | Only fallback commits before resolution; retry initializes state, commits resources, and handles an event.                                    |
| Suspense/unmount              | Resolving an initially suspended component after unmount creates no commits or resources.                                                     |
| Suspense/reject/recover       | Rejection commits an error boundary; keyed recovery mounts clean state and resources.                                                         |
| Context/keyed instances       | Context invalidates `React.memo` children with unchanged props; two instances remain independent; a key resets only its instance.             |
| External store                | Sixteen `useSyncExternalStore` updates invalidate output without another parent root render; subscriptions pair and release on unmount.       |
| Manual memo contracts         | `useMemo` and `useCallback` preserve identities and invalidate captures correctly, including M0/M1.                                           |

## Observation and synchronization

`browser/runtime.jsx` is **never React-compiled**. Its `Probe` records data and
handlers in `useLayoutEffect`, checks rendered DOM values, and retains references
to every committed output. Components are always mounted as React elements.
Current events click real mounted buttons; retained events invoke handlers saved
by a prior committed Probe. Hook behavior is established through independent
state transitions and closure captures, rather than hook-name matching.

Compiled render bodies contain pure allocations and React hooks. Resource
callbacks execute only inside effects. The harness does not add render-time
counters or freeze values. At cleanup it re-serializes every retained output and
effect dependency to detect mutation of previously committed values.

`act`, `flushSync`, controlled resource promises, and microtasks drive the flows.
Transition pending state is observed through a committed uncompiled driver.
Assertions concern committed outcomes and forbidden stale commits, not exact
render/retry counts. The first resolved promise may briefly commit an initial
fallback; transition assertions start after initial content commits. StrictMode
effect replay and fewer setups from memoization are allowed. Every actual setup
still needs one cleanup, with zero live resources/subscriptions after unmount.
The `committedProbes` count includes StrictMode effect replay and multiple Probes
in one React commit; it measures commit-phase observations, not render attempts
or unique React commits.

## Classification and artifacts

Expected outcomes are explicit in `browser/suite.mjs`. The suite additionally
compares normalized semantic checkpoints across all passing modes; cache identity
and setup-count observations are recorded separately from semantic checkpoints.

- U failure: `reference-or-harness-failure`.
- U passes and B fails: `baseline-compiler-failure`.
- U/B pass and S fails: `scheduler-counterexample`.
- U passes and M0 fails: `no-memo-baseline-failure`.
- U/M0 pass and M1 fails: `scheduler-motion-counterexample`.
- Diagnostics/emission failures and semantic disagreements receive explicit
  additional classifications. They contribute to a failed overall run.

Scheduler-specific failures are posted to `/counterexample` and printed by the
CLI as soon as their scenario group finishes. Compiler limitations stay visible
as failed compilation cells rather than being silently skipped.

Each output directory contains:

- `summary.json`: counts, browser identity, native hash, canary evidence, and classifications.
- `results.json`: every assertion count, semantic checkpoint, committed Probe,
  resource lifecycle, error, and cleanup result.
- `manifest.json`: exact compiler options, dependencies, source/compiled hashes,
  native provenance and adjacent build metadata, and final validation status.
- `sources/` and `compiled/`: input fixtures, emitted code, and per-mode JSON
  compilation records with configuration and native provenance.
- `failures/`: failed cells and immediately reported counterexamples, embedding
  the relevant source, compiled code, options, diagnostics, and native hash.
- `entry.mjs`, `bundle.js`, `bundle.js.map`, `bundle-metafile.json`, `index.html`:
  the exact browser inputs. Build/server/browser fatal errors have their own JSON.

`artifacts/` and `node_modules/` are ignored. All package/lock files and harness
sources belong to this directory; no root manifests or existing tests are changed.

Authored with AI assistance.
