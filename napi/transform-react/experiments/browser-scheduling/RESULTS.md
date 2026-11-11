# Verified browser result

**120/120 runtime cells passed** using the corrected emission-aware scheduler
binding. No scheduler-specific counterexamples or compiler diagnostics occurred
in this fixture set.

| Profile                | U     | B     | S     | M0    | M1    |
| ---------------------- | ----- | ----- | ----- | ----- | ----- |
| Development            | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| Development StrictMode | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |

- Native compilations: **46/46**, zero diagnostics or fallback cells.
- Assertions: **11,134**.
- Commit-phase Probe observations: **1,344**, including StrictMode effect replay
  and multiple Probes per commit. This is not a render-attempt count.
- Browser errors/warnings: **0**.
- Effect resource leaks and external-store subscription leaks: **0**.
- Positive instruction-motion, cache-identity, cache-invalidation, and default-off
  flag canaries: **passed**.
- Explicit `useMemo`/`useCallback` contracts: **passed in all five modes**.

## Provenance

- Native SHA-256:
  `186629bc1c5508bda813bc154eb3064159b5b12f1ed0c09bcd923793ef69e5e7`
- Binding build base: `50b124728adc093f7224bc6d60d995434653784b`
- Binding source-diff SHA-256:
  `e2fdbd4d65cac63e2eb4c84d9d4cccb684698c24bb02a882fe4662b0f5baa52f`
- Binding description: `emission-aware inert scheduler; noMemo preserves manual hooks`
- Native artifact hash verified unchanged after the run.
- React and ReactDOM: **19.2.3**, development runtime.
- Browser: **Chrome 157.0.0.0**, macOS, driven through a private Playwright browser.
- esbuild: **0.25.12**; Node: **20.20.2**.

The successful run is retained locally in `artifacts/final-186629bc/`, including
`summary.json`, the complete `results.json`, original and compiled sources,
per-mode configuration, native provenance, and the exact browser bundle.
See [README.md](README.md) for reproduction and invariant definitions.

Targeted syntax checks, repository-config Oxlint, and Oxfmt checks passed for the
harness sources. Rust was not built or changed.

An initial harness iteration counted the initial resolved-promise fallback as a
transition fallback, failing identically in U/B/S/M0/M1. The corrected invariant
starts after initial content commits. That exploratory run remains in
`artifacts/build-check/`; it was not a scheduler counterexample. The successful
intermediate run against `fd686916…` is in `artifacts/validated/`; the result above
uses the corrected `186629bc…` artifact.
