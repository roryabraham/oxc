# Offline scheduling differential experiment

A standalone, deterministic runtime harness for the experimental Oxc React
Compiler instruction scheduler. It renders real React components with **React
19.2.3** and **react-test-renderer 19.2.3**, using the real
`react/compiler-runtime`. It does not simulate memo caches or use Babel.

The question is whether legal permutations of **independent fresh
constructions** converge on the same useful memoization, while preserving
values, hooks, aliases, captured values, and effect resources. Semantic
correctness, compiler coverage, and optimization goals are separate results.

This is an offline research harness, not an exhaustive JavaScript test suite or
a wall-time benchmark. It was developed with AI assistance.

## Installation and execution

Run commands from this directory. The package and lockfile are independent of
the Oxc workspace. Node must satisfy `^20.19.0 || >=22.12.0`.

```sh
# Explicit, one-time dependency installation. No workspace install is needed.
npm ci --ignore-scripts --workspaces=false --no-audit --no-fund

# If the pinned packages are already in the npm cache, installation can also be offline.
npm ci --offline --ignore-scripts --workspaces=false --no-audit --no-fund

# No native binding is used by these generator/oracle checks.
npm run self-check

# Actual source rendering, with no compiler or scheduler claims.
node run.mjs --source-only --mode short --lifecycle all

# Default binding: ../../index.js, relative to this directory.
# --binding also accepts an absolute path to another worktree's built loader.
node run.mjs --binding /path/to/built/napi/transform-react/index.js \
  --mode short --no-memo --lifecycle all --output results/short

# All two-region schedules; deterministic bounded three-region samples.
node run.mjs --binding /path/to/built/index.js \
  --mode exhaustive --no-memo --lifecycle all --output results/bounded

# Full 630- and 2,520-permutation three-region families; substantially larger output.
node run.mjs --binding /path/to/built/index.js \
  --mode exhaustive --three-region-limit 2520 --no-memo --lifecycle all \
  --output results/full
```

The runner never installs dependencies, builds Oxc, downloads suites, or makes
network requests. A missing dependency or binding is an error. Workers use
Node's experimental VM-module support to execute native-transform ESM output
with an explicit local import allowlist. The native loader may load a local
`.node` file; WASI targets are rejected.

Use an immutable copy of the native artifact for reproducible runs. Each worker
records SHA-256 fingerprints of the loader and loaded native libraries, checks
them against other workers, and the parent checks them again after execution.
An adjacent `build-metadata.json`, when present, is included in the report.

## Variants and positive canaries

| Report key            | Compiler               | Reordering | Automatic memoization |
| --------------------- | ---------------------- | ---------- | --------------------- |
| `source` (U)          | `reactCompiler: false` | None       | None                  |
| `disabled` (B)        | Oxc                    | `false`    | Enabled               |
| `enabled` (S)         | Oxc                    | `true`     | Enabled               |
| `noMemoDisabled` (M0) | Oxc                    | `false`    | Disabled              |
| `noMemoEnabled` (M1)  | Oxc                    | `true`     | Disabled              |

Compiler variants explicitly use target `19`, `compilationMode: "infer"`,
`panicThreshold: "none"`, and `reportDiagnostics: true`. Reordering is controlled
by `reactCompiler.environment.enableInstructionReordering`.

`--no-memo` adds M0/M1 using
`reactCompiler.environment.disableMemoizationForTesting: true`. These variants
must retain explicit `useMemo`/`useCallback`; their ordinary-update identity
contracts are checked. M0/M1 isolate scheduling from automatic cache behavior,
while U also checks the rest of the compiler pipeline.

Before running the selected corpus, the runner requires a positive fresh-array
canary:

1. Source, baseline, and scheduled variants satisfy their semantic oracles.
2. The **tested function** is memoized in S.
3. B and S have different emitted code.
4. S reuses the observed `a`/`b` objects more often under independent input
   changes, in real React rendering.
5. With `--no-memo`, M0/M1 have **zero cache calls**, have different allocation
   order relative to their consumers, and M1 differs from memoized S.

An unknown option silently ignored by an older binary cannot satisfy these
checks. A failing canary stops the corpus and reports
`blocked-inactive-or-failing-canary`; it is not scheduler evidence. There is no
flag to waive it.

## Corpus

### Independent construction families

The generator enumerates linear extensions of explicit declaration/write/use
chains. Each region's operations stay ordered, and hook callsites stay ordered.
Only independent regions are treated as permutation-equivalent.

| Family                                                     | Operations per region | Hooks | Total schedules |
| ---------------------------------------------------------- | --------------------- | ----- | --------------- |
| Two empty arrays, each followed by a push                  | 2                     | 1 / 2 | 30 / 90         |
| Two empty objects, each followed by a data-property write  | 2                     | 1 / 2 | 30 / 90         |
| Objects initialized from props, followed by another write  | 2                     | 1     | 30              |
| Closure creation, followed by a wrapper using that closure | 2                     | 1 / 2 | 30 / 90         |
| Local helper declaration, followed by a call               | 2                     | 1     | 30              |
| Allocation, alias declaration, alias write                 | 3                     | 1     | 140             |
| Allocation followed by two writes                          | 3                     | 1     | 140             |
| Allocation, write, primitive read into another object      | 3                     | 1     | 140             |
| Three independent arrays                                   | 2                     | 1 / 2 | 630 / 2,520     |

Short mode already exhausts every 30/90 two-operation family. It takes eight
deterministic schedules from each larger family, including grouped,
interleaved, hook-first, and hook-split anchors. Exhaustive mode covers all
two-region schedules and defaults to a cap of 256 per three-region family.
`--three-region-limit 2520` exhausts both three-region families. The report
states the possible, selected, and actually executed counts; "exhaustive" never
means all JavaScript programs.

Each two-root case uses a seeded Euler walk of **17 visits**, covering every
directed transition among four binary root states, including all repeat states.
Three-root cases use **65 visits**, covering all 64 directed transitions among
eight states. An unrelated input changes throughout. This tests independent,
correlated, reverted, repeated, and history-dependent updates, rather than only
mount/stable/all-change.

The 30 historical `buildA`/`buildB` schedules reproduce the source from
`eslint-config-expensify/benchmarks/component-body-order/investigate-scheduling.mjs`
verbatim, including its nine-input sequence and grouped helper-call expectations.
Its demand, state-dependency, dependent-effect, and primitive-boundary examples
are included too. They run under this harness's explicit compiler options,
not an App-specific configuration. Opaque imported factories are **not** required
to gain scheduling improvements.

### Semantic and negative controls

Controls cover unknown reads and mutations; escaping closures and aliases;
read-before-write; shared inner objects; correlated inputs; getters, proxies,
computed-key coercion, and iterators/spreads; hidden throwing work and error
boundary recovery; dependent hooks; loops; mutable captures; ref-backed effects;
manual memoization; intermediate primitive equality; sparse arrays, `undefined`,
`NaN`, and signed zero; and invalid-hook/ref diagnostics with function-specific
cache expectations.

First-mount regressions also cover literal initializers containing getters,
unknown calls, const-bound calls, and TypeScript casts. They check execution
events per render attempt and the first exception from two independently
throwing getters. These scalar React components are observed from the committed
host tree, so no observation call changes their source expression structure.
They specifically catch anchored HIR operands being inlined into a moved
consumer. A positive loop-work control requires reuse of a freshly constructed
row collection across unrelated/stable input updates.

The hook-cycle control includes the valid React pattern:

```js
const a = [];
const b = [];
const [n] = useState(a.length);
a.push(n);
b.push(inputB);
```

Another control uses two `useState` callsites with distinct initial values and
independently invoked setters, including a retained old handler. Swapping
same-named hooks cannot pass merely because their names match.

A core Suspense case partially constructs an array, suspends on a real pending
promise, and retries. Optional `--lifecycle` scenarios add:

- `state`: additional state updates and retained-handler invocation;
- `strict`: root StrictMode, checked with resource balance rather than an exact
  number of effect replays;
- `remount`: a fresh React root with the same evaluated module;
- `suspense`: abandon one pending construction, replace it, resolve the
  replacement, then resolve the abandoned promise.

Use `--lifecycle all` or a comma-separated selection. Normal effect cleanup,
same-kind state dispatch, and basic suspension are tested without this flag.

## Runtime observation and independent oracles

Generated components are real JSX components rendered as React element types.
A function `Proxy` observes React's actual component invocations, hook order,
and memo-runtime access. It only forwards the invocation; it never publishes
return values as if a speculative render had committed. The historical custom
hooks are called as hooks from an uncompiled React wrapper component.
React development's no-props diagnostic stack-frame probes are counted
separately from actual render attempts, which always receive an element's props.

A separate, uncompiled `CommitObserver` publishes values in a **layout effect**.
Its render produces a host tree, which is checked against independently computed
expected data. No observer callback or allocation counter is inserted into pure
construction statements. If React reuses the observer element, its last
committed value remains the correct observation. Aborted Suspense attempts must
not publish values or run effect setups.

For every input, the result records:

- Independently expected and actual committed values, plus rendered host output.
- Identity reuse of every observed construction and the containing result.
- Hook callsites/arguments, render attempts, real Profiler commits, effect events,
  imported-helper evaluations, and real memo-cache reads/writes.
- Retained outputs and pure callbacks rechecked after later updates, detecting
  stale captures and mutation of previously committed values.

Returned identity is a useful reuse/recomputation observation, **not an exact
physical allocation counter**. Only the historical imported helpers have
evaluation counters. Their call counts are optimization observations, not
general semantic effects. Physical execution time is not an optimization oracle.

Independent formulas define expected values. A grouped compiled schedule is
never the semantic reference. Primitive serialization preserves `-0`, `NaN`,
`undefined`, missing properties, and sparse-array holes instead of losing them
through plain JSON serialization. Function values have an explicit placeholder;
only declared pure callbacks are invoked for value checks. Event handlers are
invoked deliberately through `act`, not while serializing output.

The optimization oracle checks expected dependency-local reuse and **B reuses a
particular site ⇒ S also reuses that site** on each transition. It also groups
permutation identity vectors by family. Aggregate cache slots, guard counts, or
total reuse cannot conceal a per-site regression.

Effects depending on computed objects may run fewer redundant setups in an
optimized variant. Expected setup/cleanup events use that variant's observed
dependency identity, but resource values come from independent input formulas.
Cleanup must capture its own setup's resource. There is no U=B=S effect-count or
identity-churn requirement.

## Reports and reproduction

Every run writes:

- `manifest.json`: exact task selection, seed, options, and schedule coverage.
- `summary.json`: status, canaries, native fingerprints, diagnostic/cache coverage,
  family convergence, findings, and explicit actual case/permutation/variant/
  render counts.
- `cases.jsonl`: all per-input observations, full diagnostics, per-function cache
  analysis, and code hashes for every attempted case.
- `cases/<id>/`: source JSX, every available variant's executable output, detailed
  result JSON, `repro.json`, and `reproduce.sh` for every failing case and canary.

Run a saved reproduction with:

```sh
sh results/full/cases/CASE_DIRECTORY/reproduce.sh
# Or explicitly preserve the saved execution flags:
node run.mjs --repro results/full/cases/CASE_DIRECTORY/repro.json \
  --binding /path/to/the/same/immutable/index.js --no-memo
```

`--case ID` selects exact generated IDs in the current mode. `--filter TEXT`
selects matching IDs. `--list` prints the selected tasks and planned render
requests without loading a binding. Empty selections fail.

Findings distinguish source/oracle failures, inherited baseline failures,
enabled-only regressions, M0/M1 scheduler-only regressions, diagnostic changes,
function-cache loss, per-site reuse regressions, and required/optional
optimization misses. Shared wrong output fields remain baseline findings even
when S introduces an additional wrong field. Finding counts count mismatch
details, **not failing cases**; `failingCases` lists the unique affected cases.

Literal array/object families have required independent-reuse goals. Optional
families still run semantic checks and report misses: e.g. multiple writes
straddling a hook or opaque factory calls may remain unsupported. Use
`--require-optional-goals` to make those misses fail the run too. Explicit
no-cache/opt-out functions and diagnostic-driven fallbacks are reported;
eligibility is never inferred from a module-wide runtime import.

Exit codes: `0` passed (or explicitly source-only validated), `1` findings other
than optional optimization misses, `2` blocked canary, `3` infrastructure failure
or incomplete execution. `schedulerEvidence: true` means the feature canary is
proven on a consistent binary; it does **not** mean all cases passed.

Workers are isolated child processes with a hard per-case timeout (30 seconds)
and a whole-run timeout (15 minutes). A native hang can be killed by the parent.
Progress checkpoints retain available output and counts on failure. If a worker
dies, counts are marked incomplete/lower-bound rather than presented as exact.

## Admitted subset and caveats

- The commuting families contain fresh, independent local constructions. Aliases,
  shared state, unknown calls, and other negative controls are not claimed to be
  permutation-equivalent.
- Getter/proxy/coercion/iterator event controls intentionally examine stronger
  JavaScript observability than React's render-purity assumptions. Their event
  counts can expose scheduler-enabled memoization differences without a changed
  ordinary data value. M0/M1 make this distinction visible. They remain reported
  failures, rather than being silently waived. Accesses from React's development
  prop inspection are excluded; accesses during the actual generated component
  invocation are logged.
- A signed-zero failure may originate in existing compiler cache equality and
  become visible at additional newly cached sites. This is reported by output
  field and variant, not automatically attributed to instruction movement.
- JSX observation changes the escaping result into ordinary React props. It is
  representative of a component boundary, not every possible consumer. The
  historical hook-return family covers a separate escape shape.
- Source-only preflight lowers only the explicit observer JSX form, without
  optimization. The single TypeScript-cast control supplies an explicit erased
  companion for this preflight. Normal differential runs use native
  `reactCompiler: false` for U, including native TypeScript erasure. The anchored
  operand regression controls explicitly use `compilationMode: "all"`.
- The serializer admits acyclic fixture outputs, plain data objects/arrays, and
  explicitly tested functions. It is not a general JavaScript graph serializer;
  fixture values do not use its reserved `$type` tags or function placeholder.
- This does not cover browser DOM events, hydration, every concurrent transition,
  arbitrary prototypes, every language feature, or every hook. Suspense replacement
  is a deterministic selected scenario, not exhaustive concurrent scheduling.
- React-test-renderer's known deprecation, Node's VM-module warning, and expected
  caught-error messages are recorded separately. Other React warnings fail checks.

All harness source, dependencies, generated reports, and installations live under
this directory. No Rust, production options, workspace package files, or NAPI test
fixtures are modified by running it.
