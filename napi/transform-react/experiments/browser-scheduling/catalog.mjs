export const modes = [
  { id: "U", compiler: false, reorder: false, noMemo: false },
  { id: "B", compiler: true, reorder: false, noMemo: false },
  { id: "S", compiler: true, reorder: true, noMemo: false },
  { id: "M0", compiler: true, reorder: false, noMemo: true },
  { id: "M1", compiler: true, reorder: true, noMemo: true },
];

export const profiles = [
  { id: "development", strict: false },
  { id: "development-strict", strict: true },
];

export const scenarios = [
  {
    id: "motion-cache-canary",
    fixture: "canary",
    invariant:
      "A moved pure allocation stays cached only in B/S and invalidates on its dependency.",
  },
  {
    id: "state-callsite-order",
    fixture: "state",
    invariant:
      "Distinct same-kind hook callsites retain their own state through current and retained events.",
  },
  {
    id: "retained-allocations-handlers",
    fixture: "allocations",
    invariant:
      "Current and retained helper closures see their committed values; prior outputs never mutate.",
  },
  {
    id: "layout-effect-resources",
    fixture: "effects",
    invariant:
      "Computed dependencies capture committed values, each setup is cleaned once, and unmount leaks nothing.",
  },
  {
    id: "transition-resume-urgent",
    fixture: "transition",
    invariant:
      "An urgent sibling update commits while a transition is pending; resolution commits the latest state.",
  },
  {
    id: "transition-abandon",
    fixture: "transition",
    invariant:
      "A superseded suspended transition cannot replace a newer urgent commit when it resolves.",
  },
  {
    id: "transition-motion-resume-urgent",
    fixture: "transition-motion",
    invariant:
      "A structurally verified allocation moves across useState/use while urgent updates and a suspended transition preserve all committed arrays.",
  },
  {
    id: "transition-motion-abandon",
    fixture: "transition-motion",
    invariant:
      "A structurally verified allocation moves across suspension without an abandoned render mutating committed arrays or committing stale content.",
  },
  {
    id: "suspense-initial-retry",
    fixture: "suspense",
    invariant:
      "Initial suspension commits only fallback; a retry mounts initialized state and committed effects.",
  },
  {
    id: "suspense-unmount",
    fixture: "suspense",
    invariant: "Resolving after unmount creates neither a component commit nor an effect resource.",
  },
  {
    id: "suspense-reject-recover",
    fixture: "suspense",
    invariant:
      "Rejection commits an error boundary and a keyed recovery mounts clean component state.",
  },
  {
    id: "context-keyed-instances",
    fixture: "context",
    invariant:
      "Context invalidates memoized children, instances stay independent, and keys reset only their instance.",
  },
  {
    id: "external-store-invalidation",
    fixture: "store",
    invariant:
      "Store updates invalidate compiled state without parent prop updates and subscriptions clean up.",
  },
  {
    id: "manual-memo-contracts",
    fixture: "manual",
    invariant:
      "Explicit useMemo/useCallback identities and captured values survive all five compiler modes.",
  },
  {
    id: "conditional-suspense-demand",
    fixture: "demand",
    invariant:
      "Hidden conditional use neither suspends nor throws; showing demands its promise, hiding abandons it, and later resolution cannot reveal hidden content.",
  },
  {
    id: "conditional-exception-order",
    fixture: "exceptions",
    invariant:
      "Hidden throwing computations are not demanded, and two deterministic throwing sites preserve the first observable exception.",
  },
];
