# Reviewed browser result

**160/160 runtime cells passed** on the final uniform-equality native artifact.
No scheduler-specific counterexamples or compiler diagnostics occurred in this
curated fixture set.

| Profile                | U     | B     | S     | M0    | M1    |
| ---------------------- | ----- | ----- | ----- | ----- | ----- |
| Development            | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 |
| Development StrictMode | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 |

- Native compilations: **61/61**, zero diagnostics or fallback cells.
- Assertions: **42,508**.
- Commit-phase Probe observations: **1,921**, including StrictMode effect replay
  and multiple Probes per commit; this is not a render-attempt count.
- Browser errors/warnings, effect-resource leaks, and subscription leaks: **0**.
- Allocation identity/invalidation, default-off flags, and explicit
  `useMemo`/`useCallback` contracts: **passed**.
- Emitted callsite-order and actual suspension-crossing motion gates: **passed**.

## Review gaps covered

1. **Actual concurrent motion:** two new transition scenarios use
   `transition-motion.jsx`. Emitted-AST evidence establishes these exact orders:

   ```text
   B/M0: rows=[] → useState(3) → use(resource.promise) → rows.push(payload)
   S/M1: useState(3) → use(resource.promise) → rows=[] → rows.push(payload)
   ```

   The M0/M1 allocations are direct statements in the same component block.
   Both retry/urgent-update and stale-transition abandonment run this fixture.
   The original transition cases remain conservative coverage and are not used
   to claim motion. Different cache-guard text alone cannot satisfy the gate.

2. **Complete expected values:** all allocation fields and both helper results
   are checked after every prop/state checkpoint, with non-monotonic revisions
   independent of state counts. Both state-fixture allocation arrays are also
   checked after each event and an independent seed change.
3. **Demand/exception behavior:** hidden → visible → hidden conditional `use`
   covers pending and rejected promises, abandonment, resolution while hidden,
   and keyed recovery. A separate fixture checks two deterministic throwing
   calls: the first error wins when both throw, and the second is independently
   reachable. These are curated patterns, not general JS exception equivalence.
4. **Literal hook order:** every emitted mode structurally retains unconditional
   `[left,setLeft] = useState(2)` before `[right,setRight] = useState(30)`.
   Four adversarial structural tests pass, including rejection of consistently
   swapped callsites and changed code without real motion.
5. **Aliases:** current and retained records explicitly check
   `packet.prefix === prefix`, `packet.row === row`,
   `helpers[0] === actions.describe`, `helpers[1] === actions.copy`, and
   `prefix !== row`; JSON equality is not used as alias evidence.
6. **Bounded execution:** native compilations run in a killable child process.
   Server and Playwright host watchdogs run outside the renderer and retain the
   active cell even when page JavaScript is synchronously blocked.

## Watchdog controls

These synthetic failure controls also use the final `e9aee520…` addon and are
separate from the 160-cell correctness count:

| Control                                                  | Verified outcome                                                                                                                                                                                       | Local artifact directory           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Synchronous native-worker loop                           | Parent deadline reports the exact fixture/mode/source/config/hash and kills the child with `SIGKILL`.                                                                                                  | `artifacts/control-native-e9/`     |
| No browser connects                                      | Total server deadline exits nonzero, reporting zero completed cells and `waiting-for-browser`.                                                                                                         | `artifacts/control-no-browser-e9/` |
| Synchronous renderer loop after progress acknowledgement | Server deadline records active `motion-cache-canary / development / U`, zero completed cells, and its compilation. The separate Playwright host deadline identifies the same cell and closes the page. | `artifacts/control-renderer-e9/`   |

The controls use shortened failure deadlines; ordinary defaults are 10 seconds
per native operation, 15 seconds per browser cell, 120 seconds total on the
server, and 125 seconds in the Playwright host. These are bounds, not timings or
performance measurements. Timeout controls intentionally produce failed-run
artifacts; their successful detection does not count as a passing runtime cell.

## Provenance

- Native SHA-256:
  `e9aee52041a530ec7647d656afc1669c4542220b761a8806e310057a4e32f270`
- Binding build base: `50b124728adc093f7224bc6d60d995434653784b`
- Binding build head: `85f48e253514447d25c19d7f5cf2247d8f50bf32`
- Production-source SHA-256:
  `66b82735810d74afc05d32f6c17bed25fdcbad7aebba202684847236bd59b004`
- Binding description: `emission-aware inert scheduler; uniform opt-in signed-zero guards; scope-free noMemo test control`
- Native artifact hash verified unchanged after the run.
- React and ReactDOM: **19.2.3**, development runtime.
- Browser: **Chrome 157.0.0.0**, macOS, private Playwright browser with the external
  host watchdog enabled through the generated `playwright-run.js` callback.
- esbuild **0.25.12**; Acorn **8.15.0** / acorn-jsx **5.3.2**; Node **20.20.2**.

The complete successful run is retained in `artifacts/reviewed-e9/`: summary and
full results, emitted structural evidence, source/compiled code, configuration,
native provenance, progress records, and exact browser inputs.
See [README.md](README.md) for reproduction.

Syntax/structural tests, repository-config Oxlint, Oxfmt, and diff checks passed.
The earlier 120-cell result remains in `artifacts/final-186629bc/`; its narrower
invariants did not establish actual concurrent motion or the alias/order/demand
properties added in this review follow-up.
