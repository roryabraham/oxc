# Instruction scheduling POC: results

Verified on November 11, 2026. **The experiment demonstrates useful order-independent
memoization for a bounded construction grammar. It does not establish a net application speedup.**

The implementation is a default-off, emission-aware, intra-block instruction scheduler. See the
[design and safety model](../../../crates/oxc_react_compiler/INSTRUCTION_SCHEDULING.md).

## Findings

- Independent literal constructions converge on independent caches across the supported generated
  source permutations, including interposed hooks. Calls and mutations retain their order.
- Delaying an allocation can recover caching for an entire subsequent loop without moving the loop.
- A helper creation and its invocation can share a cache despite an unrelated intervening hook in
  source. This reproduces a real App improvement without editing the component.
- Capturing or observing a partially constructed value creates a real dependency. Such cases remain
  conservative, and more complex mutation chains still have optimization misses.
- Stronger cache-key equality is necessary: the baseline compiler conflates `-0` and `+0`. Opt-in
  guards distinguish them consistently for both already-grouped and interleaved source.

## Verification

| Layer                        | Final result                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Rust compiler                | All 45 Rust tests passed, including the fixture snapshot suite; 39 new fixtures                                        |
| Native binding               | All 46 tests passed; compiler and binding Clippy checks passed                                                         |
| Generated real-React harness | 4,068 cases, 4,020 generated permutations, 20,340 transforms, 1,099,225 render attempts                                |
| Generated harness result     | No unexpected failures; 14 precisely matched assertions reproduce one baseline signed-zero defect in two controls      |
| Harness self-checks          | 26 passed, including negative controls for the oracles and expected-baseline matching                                  |
| Real browser                 | 160 cells: 16 scenarios × five compilation modes × ordinary/StrictMode roots; 61 clean compilations; 42,508 assertions |
| Browser result               | No scheduler counterexamples or resource leaks; structural and timeout fault-injection controls passed                 |
| Existing native fixtures     | 2,172 comparisons: 2,133 legacy + 39 new; no added diagnostics, invariants, or fatal failures                          |
| Tracked App source audit     | 8,581 comparisons; no added diagnostics, invariants, or fatal failures                                                 |
| App runtime showcase         | 90 renders, 90 submissions, 270 callback invocations across five modes                                                 |

Render attempts, committed observations, scenarios, and assertions are distinct counts. The generated
and browser suites use real React and its real compiler runtime. The five modes are compiler-disabled
source, baseline compilation, scheduled compilation, and unscheduled/scheduled compilation without
automatic memoization. The no-memoization modes preserve explicit `useMemo`/`useCallback` calls.

The generated suite reports **1,382 optional optimization misses**. These are outside its mandatory
normalization goals; their semantics and baseline-relative reuse still have checks. It is not a claim
that all 4,020 permutations become optimal.

The fixture audit explicitly skips two Flow fixtures and records 178 files with configuration
limitations, such as unavailable custom type providers. The App audit skips 27 declaration files and
retains 71 files' pre-existing diagnostics/fatal statuses. Four pre-compilation worker timeouts across
the final audits recovered completely; no per-file comparison remained incomplete. Audit results are
compile-only evidence, not proof of application behavior.

Omitting the option and explicitly setting it to false produced identical output throughout both
audits. Changed output is **not** an optimization count: it also includes the stronger zero guards.

## Real App result

[`app-showcase.mjs`](./app-showcase.mjs) evaluates the complete, unchanged `LegalNameStep.tsx` module
from App revision `df1e765feee11ea8983554979da24405a4b39411`, adapting the investigation's controlled
hook mocks and 18-update sequence. It mounts the actual component and observes its child after commit.

| Mode                     | Cache slots | Cache regions | Defaults-reference reuses / 18 updates |
| ------------------------ | ----------: | ------------: | -------------------------------------: |
| Compiler disabled        |           0 |             0 |                                      0 |
| Baseline compiler        |          21 |             6 |                                      9 |
| Scheduler enabled        |          19 |             5 |                                      9 |
| No-memoization baseline  |           0 |             0 |                                      0 |
| No-memoization scheduled |           0 |             0 |                                      0 |

The compiled variants have identical observed values, effects, callbacks, submissions, and reference
reuse. The no-memoization variants match the source control. This is a grouping/bookkeeping
improvement, not a measured UI latency gain; the stronger guard expressions also have costs.

The three compile-only controls from App revision `b14f3591fad1db21c32271e79e9fe66b433fc5dc` remain
important boundaries:

- `usePoliciesWithCardFeedErrors`: no caches in either version; emitted code unchanged.
- `RejectExpenseReportPage`: 98 slots in both; no claimed recovery of the split options construction.
- `useWorkspaceAgentsTable`: 13 slots in both; only the signed-zero guards change in emitted code.

The runtime showcase uses controlled imports and an inert child. It does not exercise real Onyx,
form persistence, a device UI, or production descendants.

## Costs

### Compilation

The native comparison benchmark used 66 deterministic inputs (64 sampled fixtures plus two bounded
stress cases), two warmup rounds, and eight measured rounds, alternating off/on and on/off order.
It times `transformSync`, excluding loading, IPC, hashing, and artifact writes.

- Off median per round: **9.505 ms**.
- On median per round: **9.619 ms**.
- Median paired on/off ratio: **1.021**; p95 **1.056**; observed range **0.988–1.056**.
- Sample SHA-256: `7fef74ae4e4c2945f781d2a8962a9538215e16f360e08f4c6b574bc8ee295d0c`.

This is a small, noisy local measurement, not a universal 2.1% overhead estimate or a full-build
benchmark. Both repository Rust benchmarks (`react_compiler` and `linter`) also completed with ten
samples, one-second warmups and one-second measurement targets. Those use their existing default
configuration and are integration/performance smoke checks, not scheduler-on/off comparisons.

### Emitted size

Across the 8,581 App files, raw emitted JavaScript grows from **48,207,391 to 54,473,304 bytes**:
**+6,265,913 bytes / +13.0%**. There are 4,325 larger files, 20 smaller files, and 4,236 equal-size files.
Uniform signed-zero correctness checks contribute to that cost, including in functions needing no
movement. These are unbundled, unminified byte counts—not compressed bundle sizes.

**Reducing guard overhead and profiling real interactions are prerequisites to proposing default
enablement.** Recovered memoization alone does not establish better startup, memory use, or latency.

## Review-driven corrections

Independent agent reviews were used during design, initial implementation, harness construction,
and final verification. They produced concrete changes:

1. **Deferred codegen operands:** fixing only HIR anchor order was insufficient. A getter/call could
   be inlined into a delayed consumer and execute in the wrong order. The scheduler now pins
   expression/plumbing chains carrying unmaterialized anchored evaluations. The original binary
   fails the saved getter/call/cast controls; the corrected implementation passes them.
2. **Signed zero:** newly cacheable computations exposed stale `-0`/`+0` values. Correct equality is
   used throughout opt-in compilation, including no-motion inputs. A dedicated compact control
   fails the intermediate motion-only fix and passes the final build.
3. **Test-mode method scopes:** the no-memoization control initially reached scope alignment with
   absent object-method scopes. Scope construction/alignment is now consistently skipped for that
   control. All 36 corpus reproducers pass.
4. **Oracle precision:** pure getter/proxy read counts are telemetry in memoized modes; consecutive
   duplicate reads may coalesce only within one invocation. Scheduling-only traces stay exact,
   demand order and first exceptions remain checked, and arbitrary effects are not normalized.
5. **Trustworthy quality checks:** reuse comparisons require semantically clean samples. Known
   baseline failures have exact, occurrence-checked signatures; duplicate declarations and unknown
   failures cannot be waived.
6. **Browser coverage:** added proven instruction motion across suspension, full independent values,
   aliases, hook callsite order, hidden work/competing errors, and external process deadlines.

Final independent reviews found no remaining concrete blockers in the admitted model and verified
the browser artifacts against the checked-in sources and native binary. This is AI-assisted research
and review, not a formal proof or human maintainer sign-off.

## Provenance and reproduction

- Oxc base: `50b124728adc093f7224bc6d60d995434653784b`; native package 0.158.0.
- Tested native SHA-256: `e9aee52041a530ec7647d656afc1669c4542220b761a8806e310057a4e32f270`.
- Production-source SHA-256: `66b82735810d74afc05d32f6c17bed25fdcbad7aebba202684847236bd59b004`.
- React/renderer/ReactDOM: 19.2.3. Browser: Chrome 157.0.0.0, development and StrictMode.
- Native benchmark/App showcase: Node 24.22.1, macOS arm64, Apple M5 Max, 18 logical CPUs.
- Bulk generated/browser runs used Node 20.20.2; exact per-run metadata is retained in reports.
- App audit HEAD: `6d85a77a33a811f8619bb712eae42af51b6b0e6f`.
- App tracked-source fingerprint: `82693edb88d29e2d5853c363436a2b3b8e3d11e8d22ae07fab9a92bd9625782d`;
  checked unchanged before/after the audit.

See the [generated harness](./scheduling/README.md), [browser harness](./browser-scheduling/README.md),
and [corpus audit](./corpus-audit.README.md) for installation, exact options, deadlines, artifact
formats, and negative controls. App reproduction, from the repository root with App dependencies
installed and the pinned Git revisions available:

```sh
node napi/transform-react/experiments/app-showcase.mjs --app ../App --output app-showcase.json
```

A separate compile-only reference check used published `babel-plugin-react-compiler` 1.0.0 and
`@babel/core` 7.28.5 with matching common options. Babel and baseline Oxc agreed on the three small
array/helper/opaque-call examples; the scheduler improved the first two and retained the opaque-call
boundary. Babel is not an engine in the runtime harness or the reported App measurements.

## Remaining scope

No general call-purity proof, cross-block scheduler, automatic movement of arbitrary mutation chains,
or production latency/memory assessment is included. Source equivalence excludes reflective
observations of generated anonymous-function names: outlining already changes inferred names, and
reordering can change synthetic-name assignment. There is no recommendation to enable this fork
broadly or to treat a syntactic category sort as universally optimal.
