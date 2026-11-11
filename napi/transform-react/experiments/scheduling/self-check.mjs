import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  binaryTransitionWalk,
  buildCase,
  canaryTask,
  chooseSchedules,
  DEFAULT_SEED,
  familyGraph,
  FAMILIES,
  generateSuite,
  legalSchedule,
  priorSource,
  PRIOR_EFFECT,
  PRIOR_STATEMENTS,
  scheduleCount,
  topologicalSchedules,
} from "./generate.mjs";
import {
  accessEventSequence,
  analyzeCode,
  assessCanary,
  assessVariants,
  checkAccessEvents,
  equal,
  failure,
  goalFailures,
  isInformationalFinding,
  lowerObserverJSX,
  parseSource,
  sampleSemanticallyClean,
  snapshot,
} from "./oracles.mjs";

let assertions = 0;
function verify(description, callback) {
  callback();
  assertions++;
  console.log(`ok ${assertions} - ${description}`);
}

function* allPermutations(values) {
  if (!values.length) {
    yield [];
    return;
  }
  for (let index = 0; index < values.length; index++) {
    for (const rest of allPermutations(values.filter((_, other) => other !== index)))
      yield [values[index], ...rest];
  }
}

verify("topological enumeration equals an independent brute-force permutation filter", () => {
  for (const [chains, expected] of [
    [[["A", "a"], ["B", "b"], ["E"]], 30],
    [
      [
        ["A", "a"],
        ["B", "b"],
        ["E", "F"],
      ],
      90,
    ],
    [[["A", "a"], ["B", "b"], ["C", "c"], ["E"]], 630],
    [
      [
        ["A", "a"],
        ["B", "b"],
        ["C", "c"],
        ["E", "F"],
      ],
      2520,
    ],
  ]) {
    const bruteForce = [...allPermutations(chains.flat())]
      .filter(
        (order) =>
          order.indexOf("A") < order.indexOf("a") &&
          order.indexOf("B") < order.indexOf("b") &&
          (!order.includes("C") || order.indexOf("C") < order.indexOf("c")) &&
          (!order.includes("F") || order.indexOf("E") < order.indexOf("F")),
      )
      .map((order) => order.join(""))
      .sort();
    const generated = [...topologicalSchedules(chains)].map((order) => order.join("")).sort();
    assert.equal(generated.length, expected);
    assert.equal(scheduleCount(chains), expected);
    assert.deepEqual(generated, bruteForce);
    assert.equal(new Set(generated).size, expected);
  }
});

verify(
  "deterministic bounded selection includes grouped, interleaved, and hook-split anchors",
  () => {
    const { chains } = familyGraph(FAMILIES.find(({ name }) => name === "arrays-3-h2"));
    const selected = chooseSchedules(chains, 16, 1);
    assert.deepEqual(selected, chooseSchedules(chains, 16, 1));
    assert.notDeepEqual(selected, chooseSchedules(chains, 16, 2));
    assert.equal(selected.length, 16);
    assert(selected.every((order) => legalSchedule(order, chains)));
    assert(selected.some((order) => order.join(".") === chains.flat().join(".")));
    assert(selected.some((order) => order[0] === "E1"));
    assert(selected.some((order) => order[0] === "a0" && order[1] === "E1"));
  },
);

verify("binary Euler walks cover every directed root transition, including repeats", () => {
  for (const roots of [2, 3]) {
    const walk = binaryTransitionWalk(roots, DEFAULT_SEED);
    const vertices = 2 ** roots;
    assert.equal(walk.length, roots === 2 ? 17 : 65);
    const pairs = walk.slice(1).map((value, index) => `${walk[index]}:${value}`);
    assert.equal(new Set(pairs).size, vertices * vertices);
    for (let from = 0; from < vertices; from++) {
      for (let to = 0; to < vertices; to++) assert(pairs.includes(`${from}:${to}`));
    }
  }
});

verify("short mode exhausts the 30/90 two-operation families and all prior schedules", () => {
  const { coverage } = generateSuite({ mode: "short" });
  for (const family of coverage.filter(({ possible }) => possible === 30 || possible === 90))
    assert.equal(family.selected, family.possible);
});

verify("full mode enumerates 630/2520 three-region schedules, with unique source IDs", () => {
  const suite = generateSuite({
    mode: "exhaustive",
    threeRegionLimit: 2520,
    lifecycle: ["state", "strict", "remount", "suspense"],
  });
  assert.equal(suite.coverage.find(({ family }) => family === "arrays-3-h1").selected, 630);
  assert.equal(suite.coverage.find(({ family }) => family === "arrays-3-h2").selected, 2520);
  assert.equal(new Set(suite.tasks.map(({ id }) => id)).size, suite.tasks.length);
  for (const task of suite.tasks) {
    const spec = buildCase(task);
    parseSource(spec.sourceWithoutTypes ?? spec.source);
    analyzeCode(lowerObserverJSX(spec.sourceWithoutTypes ?? spec.source));
    assert(spec.updates.length > 0);
  }
});

verify("the historical grouped baseline source is verbatim", () => {
  assert.equal(
    priorSource([..."AaBbE"].map((token) => PRIOR_STATEMENTS[token]).join("\n")),
    `import {useEffect, useState} from 'react';
import {buildA, buildB, cheap, expensive, observe} from './operations';
export default function useSchedulingProbe({inputA, inputB, visible}) {
const a = buildA(inputA);
a.push(1);
const b = buildB(inputB);
b.push(2);
${PRIOR_EFFECT}
return {a, b};
}`,
  );
});

verify("source-only JSX lowering is narrowly scoped and rejects unrecognized JSX", () => {
  const text = "const view = <CommitObserver value={{a: [1], b: [2]}} />;";
  assert.equal(
    lowerObserverJSX(text),
    "const view = createElement(CommitObserver, {value: {a: [1], b: [2]}});",
  );
  assert.throws(() => lowerObserverJSX("const view = <Other value={1} />;"));
});

verify("semantic serialization distinguishes zero sign, NaN, undefined, holes, and null", () => {
  assert(!equal(-0, 0));
  assert(equal(NaN, Number.NaN));
  assert(!equal([undefined], Array(1)));
  assert(!equal({ value: undefined }, {}));
  assert(!equal(undefined, null));
  assert(!equal([NaN], [null]));
  assert.deepEqual(snapshot(Array(1)), [{ $type: "hole" }]);
});

verify(
  "pure accessor telemetry accepts only consecutive duplicate reads in memoized variants",
  () => {
    const expected = ["get:left", "get:right"];
    const repeated = ["get:left", "get:left", "get:left", "get:right", "get:right", "get:right"];
    const reversed = ["get:right", "get:right", "get:right", "get:left", "get:left", "get:left"];
    const original = [...repeated];
    for (const variant of ["disabled", "enabled"]) {
      assert.deepEqual(accessEventSequence(expected, variant, "pure-accessor-reads"), expected);
      assert.deepEqual(accessEventSequence(repeated, variant, "pure-accessor-reads"), expected);
      assert.notDeepEqual(accessEventSequence(reversed, variant, "pure-accessor-reads"), expected);
      assert.notDeepEqual(
        accessEventSequence(["get:left", "get:right", "get:left"], variant, "pure-accessor-reads"),
        expected,
      );
      assert.deepEqual(accessEventSequence(repeated, variant, undefined), repeated);
    }
    for (const variant of ["source", "noMemoDisabled", "noMemoEnabled"]) {
      assert.deepEqual(accessEventSequence(expected, variant, "pure-accessor-reads"), expected);
      assert.deepEqual(accessEventSequence(repeated, variant, "pure-accessor-reads"), repeated);
      assert.notDeepEqual(accessEventSequence(repeated, variant, "pure-accessor-reads"), expected);
    }
    assert.deepEqual(repeated, original, "Raw measurements must remain untouched");
  },
);

verify(
  "accessor coalescing cannot normalize unknown calls, coercions, iterators, or other properties",
  () => {
    for (const event of ["call:left", "key:left", "iterate:left", "get:other"]) {
      const events = [event, event, "get:right"];
      assert.deepEqual(accessEventSequence(events, "enabled", "pure-accessor-reads"), events);
    }
    const names = generateSuite()
      .tasks.filter((task) => buildCase(task).accessEventPolicy === "pure-accessor-reads")
      .map(({ name }) => name)
      .sort();
    assert.deepEqual(names, ["getter", "proxy", "typecast-getter-order", "unnamed-getter-order"]);
    const throwing = buildCase({ kind: "control", name: "throwing-getter-order", seed: 1 });
    assert.equal(throwing.accessEventPolicy, undefined);
    assert.deepEqual(throwing.expectedEvents, ["get:left"]);
    assert.equal(throwing.updates[0].error, "left-error");
    assert.deepEqual(
      accessEventSequence(["get:left", "get:left"], "enabled", throwing.accessEventPolicy),
      ["get:left", "get:left"],
    );
  },
);

verify(
  "independent semantic expectations encode selected roots rather than executing source",
  () => {
    const spec = buildCase(canaryTask(5));
    assert.deepEqual(spec.expected({ inputA: 7, inputB: 19 }), { a: [7], b: [19] });
    const alias = buildCase({ kind: "control", name: "alias-read-write", seed: 5 });
    assert.deepEqual(alias.expected({ inputA: 7, inputB: 19 }), {
      a: [7, 19],
      b: [1],
      alias: [7, 19],
      before: 1,
    });
    const shared = buildCase({ kind: "control", name: "shared-inner", seed: 5 });
    assert.deepEqual(shared.expected({ inputA: 7, inputB: 19 }), {
      a: [{ value: 26 }],
      b: [{ value: 26 }],
      before: 7,
    });
  },
);

verify("cache attribution distinguishes individual functions and nested functions", () => {
  const analysis = analyzeCode(`import {c as cache} from 'react/compiler-runtime';
export function Compiled() { const $ = cache(4); return function nested() { return cache(2); }; }
export function Skipped() { return 0; }`);
  assert.equal(analysis.functions.Compiled.cacheCalls, 1);
  assert.deepEqual(analysis.functions.Compiled.slots, [4]);
  assert.equal(analysis.functions["Compiled.nested"].cacheCalls, 1);
  assert.equal(analysis.functions.Skipped.cacheCalls, 0);
});

const emptyVariant = () => ({
  failures: [],
  diagnostics: [],
  analysis: { functions: {} },
  samples: [],
});
verify("a per-site reuse regression is caught even when aggregate reuse improves elsewhere", () => {
  const source = emptyVariant();
  const disabled = {
    ...emptyVariant(),
    samples: [{ label: "onlyB", committed: true, same: { a: true, b: false, c: false } }],
  };
  const enabled = {
    ...emptyVariant(),
    samples: [{ label: "onlyB", committed: true, same: { a: false, b: true, c: true } }],
  };
  const findings = assessVariants({ source, disabled, enabled }, {});
  assert(
    findings.some(
      ({ classification, check }) =>
        classification === "optimization-regression" && check === "baseline-reuse-preserved:a",
    ),
  );
});

verify("baseline semantic failures remain separate from new failing output fields", () => {
  const source = emptyVariant();
  const disabled = {
    ...emptyVariant(),
    failures: [failure("values", { a: 1, b: -0 }, { a: 1, b: 0 }, "step")],
  };
  const enabled = {
    ...emptyVariant(),
    failures: [failure("values", { a: 9, b: -0 }, { a: 1, b: 0 }, "step")],
  };
  const findings = assessVariants({ source, disabled, enabled }, {});
  assert(
    findings.some(
      ({ classification, path }) =>
        classification === "baseline-compiler-failure" && path === "$.b",
    ),
  );
  assert(
    findings.some(
      ({ classification, path }) => classification === "enabled-regression" && path === "$.a",
    ),
  );
});

verify("reuse and optimization goals require clean samples at both transition endpoints", () => {
  const samples = [
    { label: "mount", committed: true, input: { inputA: 1 }, same: { a: null } },
    { label: "stable", committed: true, input: { inputA: 1 }, same: { a: false } },
  ];
  const baselineSamples = samples.map((sample, index) => ({ ...sample, same: { a: index > 0 } }));
  const spec = { goal: { required: true, dependencies: { a: ["inputA"] } } };
  const hasReuseRegression = (disabled, enabled) =>
    assessVariants({ source: emptyVariant(), disabled, enabled }, {}).some(
      ({ classification }) => classification === "optimization-regression",
    );
  const baseline = { ...emptyVariant(), samples: baselineSamples };
  const scheduled = { ...emptyVariant(), samples };
  assert(hasReuseRegression(baseline, scheduled));
  assert.equal(goalFailures(spec, samples).length, 1);
  for (const step of ["mount", "stable"]) {
    const failures = [failure("returned-values", -0, 0, step)];
    assert(!hasReuseRegression({ ...baseline, failures }, scheduled));
    assert(!hasReuseRegression(baseline, { ...scheduled, failures }));
    assert.equal(goalFailures(spec, samples, failures).length, 0);
    assert(
      !sampleSemanticallyClean(
        samples.find(({ label }) => label === step),
        failures,
      ),
    );
  }
  assert.equal(goalFailures(spec, samples, [failure("other-step", 1, 2, "unrelated")]).length, 1);
  assert.equal(
    goalFailures(spec, samples, [failure("react-warning", true, false, null, "runtime")]).length,
    0,
  );
  assert.equal(
    goalFailures(
      spec,
      samples.map((sample) => ({ ...sample, semanticallyClean: false })),
    ).length,
    0,
  );
});

verify(
  "expected baseline defects match exact cases, steps, paths, and values and must occur",
  () => {
    const taskId = "control/special-primitives";
    const defect = {
      id: "signed-zero-positive-zero",
      caseId: taskId,
      kind: "semantic",
      check: "returned-values",
      step: "positive-zero",
      path: "$.holes.1",
      actual: { $type: "negative-zero" },
      expected: 0,
    };
    const spec = { expectedBaselineDefects: [defect] };
    const rawFailure = failure(
      "returned-values",
      { holes: [1, -0] },
      { holes: [1, 0] },
      "positive-zero",
    );
    const variants = {
      source: emptyVariant(),
      disabled: { ...emptyVariant(), failures: [rawFailure] },
      enabled: emptyVariant(),
    };
    const expected = assessVariants(variants, spec, taskId);
    assert.deepEqual(
      expected.map(({ classification }) => classification),
      ["expected-baseline-defect"],
    );
    assert(expected.every(({ classification }) => isInformationalFinding(classification)));
    for (const [changedSpec, changedTask] of [
      [{ expectedBaselineDefects: [{ ...defect, step: "negative-zero" }] }, taskId],
      [{ expectedBaselineDefects: [{ ...defect, path: "$.a.0" }] }, taskId],
      [{ expectedBaselineDefects: [{ ...defect, actual: 7 }] }, taskId],
      [{ expectedBaselineDefects: [{ ...defect, expected: 7 }] }, taskId],
      [spec, "control/another-case"],
    ]) {
      const findings = assessVariants(variants, changedSpec, changedTask);
      assert(
        findings.some(
          ({ classification }) => classification === "expected-baseline-defect-mismatch",
        ),
      );
      assert(!findings.some(({ classification }) => classification === "expected-baseline-defect"));
    }
    const missing = assessVariants({ ...variants, disabled: emptyVariant() }, spec, taskId);
    assert(
      missing.some(({ classification }) => classification === "expected-baseline-defect-mismatch"),
    );
    const duplicates = assessVariants(
      { ...variants, disabled: { ...emptyVariant(), failures: [rawFailure, rawFailure] } },
      spec,
      taskId,
    );
    assert(
      duplicates.some(
        ({ classification }) => classification === "expected-baseline-defect-mismatch",
      ),
    );
    const extra = assessVariants(
      {
        ...variants,
        disabled: {
          ...emptyVariant(),
          failures: [rawFailure, failure("returned-values", { a: 9 }, { a: 1 }, "positive-zero")],
        },
      },
      spec,
      taskId,
    );
    assert(
      extra.some(
        ({ classification }) => classification === "baseline-failure-not-reproduced-enabled",
      ),
    );
    assert(!isInformationalFinding("baseline-failure-not-reproduced-enabled"));
    assert(!isInformationalFinding("baseline-no-memo-failure-not-reproduced-enabled"));
  },
);

verify("baseline expectations cannot waive source, enabled, or no-memo value failures", () => {
  const taskId = "control/special-primitives";
  const spec = {
    expectedBaselineDefects: [
      {
        id: "signed-zero",
        caseId: taskId,
        kind: "semantic",
        check: "returned-values",
        step: "positive-zero",
        path: "$.holes.1",
        actual: { $type: "negative-zero" },
        expected: 0,
      },
    ],
  };
  const defect = failure("returned-values", { holes: [1, -0] }, { holes: [1, 0] }, "positive-zero");
  const wrong = { ...emptyVariant(), failures: [defect] };
  const variants = { source: emptyVariant(), disabled: wrong, enabled: emptyVariant() };
  for (const [name, classification] of [
    ["source", "source-or-oracle-failure"],
    ["enabled", "enabled-regression"],
    ["noMemoDisabled", "baseline-no-memo-failure-not-reproduced-enabled"],
    ["noMemoEnabled", "scheduler-only-regression"],
  ]) {
    const findings = assessVariants(
      { ...variants, noMemoDisabled: emptyVariant(), noMemoEnabled: emptyVariant(), [name]: wrong },
      spec,
      taskId,
    );
    assert(
      findings.some((finding) => finding.classification === classification),
      name,
    );
    assert(!isInformationalFinding(classification));
  }
});

verify(
  "the declared baseline inventory covers only the signed-zero value and its retained consequences",
  () => {
    const cases = generateSuite().tasks.filter(
      (task) => buildCase(task).expectedBaselineDefects?.length,
    );
    assert.deepEqual(
      cases.map(({ id }) => id),
      ["control/special-primitives", "control/special-primitives-compact"],
    );
    const defects = buildCase(cases[0]).expectedBaselineDefects;
    assert.equal(new Set(defects.map(({ id }) => id)).size, 5);
    assert(
      defects.every(
        ({ caseId, kind }) => caseId === "control/special-primitives" && kind === "semantic",
      ),
    );
    assert.deepEqual(
      defects.map(({ check, step, path }) => [check, step, path]),
      [
        ["returned-values", "positive-zero", "$.holes.1"],
        ["retained-output:positive-zero", "NaN", "$.holes.1"],
        ["retained-output:positive-zero", "NaN-stable", "$.holes.1"],
        ["retained-output:positive-zero", "undefined", "$.holes.1"],
        ["rendered-host-tree", "positive-zero", "$.children.0"],
      ],
    );
    const compactDefects = buildCase(cases[1]).expectedBaselineDefects;
    assert.equal(new Set([...defects, ...compactDefects].map(({ id }) => id)).size, 14);
    assert(
      compactDefects.every(
        ({ caseId, kind }) =>
          caseId === "control/special-primitives-compact" && kind === "semantic",
      ),
    );
    assert.deepEqual(
      compactDefects.map(({ check, step, path }) => [check, step, path]),
      [
        ["returned-values", "positive-zero", "$.a.0"],
        ["returned-values", "positive-zero", "$.holes.1"],
        ["retained-output:positive-zero", "NaN", "$.a.0"],
        ["retained-output:positive-zero", "NaN", "$.holes.1"],
        ["retained-output:positive-zero", "NaN-stable", "$.a.0"],
        ["retained-output:positive-zero", "NaN-stable", "$.holes.1"],
        ["retained-output:positive-zero", "undefined", "$.a.0"],
        ["retained-output:positive-zero", "undefined", "$.holes.1"],
        ["rendered-host-tree", "positive-zero", "$.children.0"],
      ],
    );
  },
);

verify("diagnostic loss and function cache loss are independent coverage failures", () => {
  const source = emptyVariant();
  const disabled = {
    ...emptyVariant(),
    diagnostics: [{ severity: "Warning", message: "Invalid hook" }],
    analysis: { functions: { Expected: { cacheCalls: 1 } } },
  };
  const findings = assessVariants({ source, disabled, enabled: emptyVariant() }, {});
  assert(findings.some(({ classification }) => classification === "enabled-diagnostic-change"));
  assert(findings.some(({ classification }) => classification === "enabled-cache-coverage-loss"));
});

verify("optimization goals use independent root changes and nested primitive dependencies", () => {
  const spec = { goal: { dependencies: { a: ["inputA.length"], b: ["inputB"] }, result: true } };
  const samples = [
    { label: "mount", input: { inputA: [1, 2], inputB: 3 }, committed: true, same: {} },
    {
      label: "same-length",
      input: { inputA: [8, 9], inputB: 4 },
      committed: true,
      same: { a: false, b: false, $result: false },
    },
  ];
  assert.deepEqual(
    goalFailures(spec, samples).map(({ check }) => check),
    ["independent-reuse:a"],
  );
});

verify("canary rejects ignored flags, cache-only claims, and unchanged no-memo scheduling", () => {
  const cached = (code, same) => ({
    ...emptyVariant(),
    code,
    analysis: { functions: { SchedulingProbe: { cacheCalls: 1 } } },
    samples: [{ same }],
  });
  const source = emptyVariant();
  const disabled = cached("before", { a: false, b: false });
  const enabled = cached("after", { a: true, b: true });
  assert(assessCanary({ variants: { source, disabled, enabled } }).passed);
  assert(
    !assessCanary({ variants: { source, disabled, enabled: { ...enabled, code: disabled.code } } })
      .passed,
  );
  assert(
    !assessCanary({
      variants: { source, disabled, enabled: { ...enabled, samples: disabled.samples } },
    }).passed,
  );
  const noMemo = {
    ...emptyVariant(),
    code: "noMemo",
    analysis: {
      functions: {},
      operationOrder: { SchedulingProbe: ["a:ArrayExpression", "a.push"] },
    },
  };
  assert(
    !assessCanary(
      { variants: { source, disabled, enabled, noMemoDisabled: noMemo, noMemoEnabled: noMemo } },
      true,
    ).passed,
  );
});

verify("retained snapshots detect mutation, and closure projection remains explicit", () => {
  const value = { items: [1], read: () => 2 };
  const expected = snapshot(value, { invoke: true });
  value.items.push(3);
  assert(!equal(snapshot(value, { invoke: true }), expected));
  let actions = 0;
  assert.equal(
    snapshot({ increment: () => actions++ }, { invoke: true, actions: ["increment"] }).increment,
    "<function>",
  );
  assert.equal(actions, 0);
});

verify("zero-case CLI selections fail instead of producing a passing empty run", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./run.mjs", import.meta.url)),
      "--list",
      "--filter",
      "nonexistent-test-case",
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 3);
  assert.match(result.stderr, /zero cases/);
});

verify(
  "access events are normalized within invocations without borrowing reads from a replay",
  () => {
    const expected = ["get:left", "get:right"];
    const attempt = (externalEvents) => ({ externalEvents });
    const replay = [attempt(["get:left"]), attempt(["get:left", "get:right"])];
    assert.deepEqual(
      accessEventSequence(
        replay.flatMap(({ externalEvents }) => externalEvents),
        "enabled",
        "pure-accessor-reads",
      ),
      expected,
    );
    const failures = [];
    checkAccessEvents(failures, replay, expected, "enabled", "pure-accessor-reads", "update");
    assert.deepEqual(
      failures.map(({ check }) => check),
      ["execution-events:attempt-0"],
    );
    for (const count of [1, 2, 4]) {
      const strictReplay = Array.from({ length: count }, () => attempt([...expected]));
      const actual = [];
      checkAccessEvents(actual, strictReplay, expected, "source", "pure-accessor-reads", "update");
      assert.deepEqual(actual, []);
    }
    const repeated = [
      attempt(expected),
      attempt(["get:left", "get:left", "get:right", "get:right"]),
    ];
    const memoized = [];
    checkAccessEvents(memoized, repeated, expected, "enabled", "pure-accessor-reads", "update");
    assert.deepEqual(memoized, []);
    for (const variant of ["source", "noMemoDisabled", "noMemoEnabled"]) {
      const exact = [];
      checkAccessEvents(exact, repeated, expected, variant, "pure-accessor-reads", "update");
      assert.deepEqual(
        exact.map(({ check }) => check),
        ["execution-events:attempt-1"],
      );
    }
  },
);

verify("duplicate baseline declaration IDs and signatures are rejected before any matching", () => {
  const taskId = "control/special-primitives";
  const defect = {
    id: "signed-zero",
    caseId: taskId,
    kind: "semantic",
    check: "returned-values",
    step: "positive-zero",
    path: "$.holes.1",
    actual: { $type: "negative-zero" },
    expected: 0,
  };
  const rawFailure = failure(
    "returned-values",
    { holes: [1, -0], a: [-0] },
    { holes: [1, 0], a: [0] },
    "positive-zero",
  );
  const variants = {
    source: emptyVariant(),
    disabled: { ...emptyVariant(), failures: [rawFailure] },
    enabled: emptyVariant(),
  };
  for (const [declarations, field] of [
    [[defect, { ...defect, path: "$.a.0" }], "id"],
    [[defect, { ...defect, id: "another-id" }], "signature"],
  ]) {
    const findings = assessVariants(variants, { expectedBaselineDefects: declarations }, taskId);
    assert(
      findings.some(
        ({ classification, check }) =>
          classification === "expected-baseline-declaration-duplicate" &&
          check === `baseline-defect-${field}-unique`,
      ),
    );
    assert(!findings.some(({ classification }) => classification === "expected-baseline-defect"));
  }
  assert(!isInformationalFinding("expected-baseline-declaration-duplicate"));
});

verify(
  "compact signed-zero control keeps the numeric trace and requires unchanged no-memo output",
  () => {
    const original = buildCase({ kind: "control", name: "special-primitives", seed: 1 });
    const compact = buildCase({ kind: "control", name: "special-primitives-compact", seed: 1 });
    assert.deepEqual(compact.updates, original.updates);
    assert.deepEqual(compact.hooks, []);
    assert.deepEqual(compact.effects, []);
    for (const input of compact.updates)
      assert.deepEqual(compact.expected(input), original.expected(input));
    assert(
      compact.source.indexOf("const a = [props.inputA]") <
        compact.source.indexOf("const b = {value: props.inputB}"),
    );
    const variants = {
      source: emptyVariant(),
      disabled: emptyVariant(),
      enabled: emptyVariant(),
      noMemoDisabled: { ...emptyVariant(), code: "same" },
      noMemoEnabled: { ...emptyVariant(), code: "same" },
    };
    const taskId = "control/special-primitives-compact";
    assert(
      !assessVariants(variants, {}, taskId).some(
        ({ classification }) => classification === "no-motion-control-failure",
      ),
    );
    assert(
      assessVariants(
        { ...variants, noMemoEnabled: { ...emptyVariant(), code: "changed" } },
        {},
        taskId,
      ).some(({ classification }) => classification === "no-motion-control-failure"),
    );
  },
);

console.log(
  JSON.stringify({ selfChecks: assertions, status: "passed", noNativeBindingUsed: true }),
);
