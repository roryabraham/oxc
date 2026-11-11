# Experimental construction scheduling

This personal-fork experiment investigates whether equivalent, legal source orderings can converge
on equivalent React Compiler memoization. It was developed with AI assistance and independent
agent reviews. It is an opt-in research extension, not an upstream-supported compiler option.

## Motivation and sources

- [App investigation](https://github.com/Expensify/App/issues/105956)
- [Ordering experiments and runtime harness](https://github.com/Expensify/eslint-config-expensify/pull/212)
- [React team's explanation of hook-crossing scopes and instruction reordering](https://github.com/react/react/issues/35237#issuecomment-3880689584)
- Oxc base revision: `50b124728adc093f7224bc6d60d995434653784b` (`oxc-transform-react` 0.158.0).

Mutable construction ranges that overlap can merge into one cache, coupling unrelated inputs.
A hook inside a construction's range can prevent caching altogether. A category-based source sort
does not address these problems reliably: moving only a declaration can separate it from its
mutations. Guard counts also cannot detect broadened invalidation dependencies.

## What changed

An experimental HIR scheduling pass runs before alias/effect analysis and mutable-range inference.
The existing analyses therefore operate on the scheduled instructions, rather than stale ranges or
effects inferred for another order. The option is disabled by default:

```js
transformSync(filename, source, {
  reactCompiler: {
    reportDiagnostics: true,
    environment: { enableInstructionReordering: true },
  },
});
```

Only client compilation schedules instructions. SSR and lint output retain their existing order.
The TypeScript reference compiler has no equivalent option; differences with it are intentional
experimental optimization differences, not claimed upstream parity fixes.

The fork also exposes `environment.disableMemoizationForTesting`. This test-only control skips
automatic cache construction and retains explicit `useMemo`/`useCallback` calls. Running it with
scheduling disabled and enabled isolates code motion from automatic memoization. It is not a
supported production API. `reactCompiler: false` alone is not a scheduling-only control: it bypasses
the entire compiler, including this pass.

All opt-in cache guards also distinguish `+0` from `-0`. The baseline compiler's `!==`
comparison conflates them; recovering a cache can therefore expose a stale signed-zero value in
an otherwise uncached computation. The opt-in guard adds a short-circuited numeric-zero reciprocal
comparison, without referencing shadowable globals. NaN retains the baseline's conservative
invalidation behavior. Consistent equality for compact and interleaved inputs is necessary even
when the compact input needs no movement. Default-off code generation is unchanged. The stronger
guards add generated-code size and runtime checks; those costs must be weighed against recovered
memoization rather than treating instruction motion as free.

## What matters for this implementation

The first transformation is **inert-producer sinking**. It shortens construction lifetimes without
changing the execution order of arbitrary calls, hooks, property accesses or mutations:

```js
// Input
const a = [];
const b = [];
useState(0);
a.push(x);
b.push(y);

// Scheduling objective
useState(0);
const a = [];
a.push(x);
const b = [];
b.push(y);
```

The pass works inside basic blocks. In a reverse walk, each eligible definition receives a deadline
at its earliest scheduled use or the next barrier. Deadlines propagate through producer chains.
Sorting by deadline and original index preserves dependency order and every anchored instruction's
relative order. Evaluation-order IDs are then refreshed. The algorithm is bounded by the number of
instructions and operand edges, plus per-block `O(n log n)` sorting; it does not enumerate schedules
in production.

The allowlist includes primitive literals, eligible local binding plumbing, type casts, arrays
without spreads, objects with static ordinary data properties, and eligible function-expression
creations. Operand evaluation remains separate: permitting an object literal does not permit
moving a getter or an unknown function call that supplied one of its values.

Eligibility also tracks **deferred code generation**. Unnamed HIR operands can be expressions that
codegen inlines into their consumer rather than already-evaluated registers. An eligible tree may
contain only inert unnamed operands or named, materialized bindings. A getter/call-backed unnamed
operand pins its construction and binding chain. Independent review found that checking HIR anchor
positions alone could reverse two getter/call evaluations; the regression corpus includes both
normal results and first-exception ordering for this failure mode.

Mutable binding writes, manual-memoization markers, debugger statements and opaque TypeScript enum
declarations are barriers. Value/sequence blocks and caught-exception instruction layouts are
excluded. No instruction moves to a different branch, across an early return or across a loop edge.

## Proof obligations

1. **No execution of user code:** the moved instruction is an allowlisted inert operation. Spreads,
   computed keys, coercions, calls, property accesses, JSX creation and mutation are anchored.
2. **No earlier execution:** definitions only move later inside the same basic block.
3. **No use before definition:** a moved definition precedes its first consumer, including aliases
   and closure captures. Stable source-order ties retain producer/consumer order.
4. **No changed binding observation:** source declaration identity, not just SSA version identity,
   constrains reads; mutable bindings and their writes are treated conservatively.
5. **No hidden escape:** a value is materialized before any operation that can observe it or capture
   it in an escaping object/function. Unknown calls keep their order even if the compiler can memoize
   them independently.
6. **Fresh analysis:** alias/effect inference, mutable ranges, scope merging and hook-scope flattening
   run on the final schedule. The optimization does not relax mutation assumptions.
7. **Emission preserves the schedule:** delayed expression trees cannot carry an anchored unnamed
   evaluation into a later codegen position. This is checked independently of HIR data dependencies.

These obligations are an engineering argument for the admitted subset, not a machine-checked proof
of arbitrary JavaScript equivalence. As with ordinary compiler allocation optimizations, resource
exhaustion, garbage-collection timing and debugger allocation observations are not the semantic
contract.

## Implementation checklist

- [x] Establish passing unmodified compiler tests.
- [x] Add a default-off option and an initial bounded scheduler.
- [x] Add compiler-output fixtures and a native option fixture.
- [x] Independently review the safety model and test oracles.
- [x] Run generated legal-order permutations with real React and uncompiled controls.
- [x] Exercise adversarial aliases, captures, throws, suspension and lifecycle behavior.
- [x] Audit the existing compiler fixture corpus with scheduling enabled.
- [x] Measure native compiler overhead and representative runtime execution/reuse behavior.
- [x] Record reproducible results, unresolved limitations and review outcomes.

## Risks and unknowns

- This pass cannot reunite a construction with multiple effectful mutations straddling a hook.
  It cannot move an unknown `buildItems(data)` call solely because it returns a fresh-looking value.
- A hook that consumes the partially constructed value creates a real dependency. More aggressive
  scheduling cannot remove that dependency; splitting caches would be a separate project.
- Legal code motion does not itself guarantee improved caching, latency or retained memory. The
  runtime harness must compare independent input updates and intermediate equality checkpoints.
- Greater reference stability is an intended memoization effect. Exact identity churn and effect
  setup counts need a deliberate oracle; rendered-value equality alone is insufficient.
- Reflective observations of generated anonymous-function names are outside the admitted model.
  Independent review verified that upstream-style outlining already changes inferred names, and
  scheduling can change the order in which those synthetic names are assigned. The experiment does
  not claim source-equivalent `Function.name`, stack text or `Function.prototype.toString` behavior.
- Exhaustive enumeration is only practical for bounded grammars. Generated counts must not be
  presented as coverage of every valid React component or every JavaScript behavior.

The offline runtime harness and its measured coverage are documented under
`napi/transform-react/experiments/scheduling/`.

See [the final results](../../napi/transform-react/experiments/RESULTS.md) for measured gains,
generated-code costs, reviewed failure modes and reproduction instructions.
