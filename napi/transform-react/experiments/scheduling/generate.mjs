import assert from "node:assert/strict";

export const DEFAULT_SEED = 0x5ced0123;
export const MODES = ["short", "exhaustive"];

export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(text, seed = DEFAULT_SEED) {
  let value = seed >>> 0;
  for (const character of text) {
    value = Math.imul(value ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  return value;
}

// A linear extension preserves each region's declaration/write/use chain and hook order.
export function* topologicalSchedules(chains, prefix = [], positions = chains.map(() => 0)) {
  if (positions.every((position, index) => position === chains[index].length)) {
    yield prefix;
    return;
  }
  for (let index = 0; index < chains.length; index++) {
    const position = positions[index];
    if (position === chains[index].length) continue;
    const nextPositions = [...positions];
    nextPositions[index]++;
    yield* topologicalSchedules(chains, [...prefix, chains[index][position]], nextPositions);
  }
}

export function scheduleCount(chains) {
  const factorial = (n) => {
    let result = 1n;
    for (let i = 2n; i <= BigInt(n); i++) result *= i;
    return result;
  };
  return Number(
    factorial(chains.reduce((sum, chain) => sum + chain.length, 0)) /
      chains.reduce((product, chain) => product * factorial(chain.length), 1n),
  );
}

export function legalSchedule(schedule, chains) {
  const allTokens = chains.flat();
  return (
    schedule.length === allTokens.length &&
    new Set(schedule).size === allTokens.length &&
    allTokens.every((token) => schedule.includes(token)) &&
    chains.every((chain) =>
      chain.every(
        (token, index) =>
          index === 0 || schedule.indexOf(chain[index - 1]) < schedule.indexOf(token),
      ),
    )
  );
}

function anchors(chains) {
  const regions = chains.slice(0, -1);
  const hooks = chains.at(-1);
  const roundRobin = [];
  for (let index = 0; index < Math.max(...regions.map((chain) => chain.length)); index++) {
    for (const chain of regions) if (chain[index]) roundRobin.push(chain[index]);
  }
  return [
    [...regions.flat(), ...hooks],
    [...hooks, ...regions.flat()],
    [...roundRobin, ...hooks],
    [...hooks, ...roundRobin],
    [regions[0][0], ...hooks, ...regions[0].slice(1), ...regions.slice(1).flat()],
    [...regions.map((chain) => chain[0]), ...hooks, ...regions.flatMap((chain) => chain.slice(1))],
    [...regions.toReversed().flat(), ...hooks],
  ];
}

export function chooseSchedules(chains, limit, seed) {
  const all = [...topologicalSchedules(chains)];
  if (limit >= all.length) return all;
  const chosen = new Map();
  const add = (schedule) => chosen.set(schedule.join("."), schedule);
  for (const schedule of anchors(chains)) {
    if (chosen.size >= limit) break;
    add(schedule);
  }
  const shuffled = [...all];
  const next = random(seed);
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(next() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  for (const schedule of shuffled) {
    if (chosen.size >= limit) break;
    add(schedule);
  }
  return [...chosen.values()];
}

const HOOKS = [
  "createElement",
  "useEffect",
  "useLayoutEffect",
  "useState",
  "useRef",
  "useMemo",
  "useCallback",
  "use",
];
const OPERATIONS = [
  "observe",
  "buildA",
  "buildB",
  "cheap",
  "expensive",
  "snapshot",
  "mutate",
  "capture",
  "mayThrow",
];

export function source(
  body,
  returned = "{a, b}",
  parameters = "{inputA, inputB, inputC, visible, data, resource}",
) {
  return `import {${HOOKS.join(", ")}} from 'react';
import {${OPERATIONS.join(", ")}} from './operations';
import {CommitObserver} from './observer';
export default function SchedulingProbe(${parameters}) {
${body}
return <CommitObserver value={${returned}} />;
}`;
}

// The wrapper, imports, statements, and result match investigate-scheduling.mjs exactly.
export function priorSource(body, returned = "{a, b}") {
  return `import {useEffect, useState} from 'react';
import {buildA, buildB, cheap, expensive, observe} from './operations';
export default function useSchedulingProbe({inputA, inputB, visible}) {
${body}
return ${returned};
}`;
}

export const PRIOR_EFFECT =
  'useEffect(() => { observe("setup"); return () => observe("cleanup"); }, []);';
export const PRIOR_STATEMENTS = {
  A: "const a = buildA(inputA);",
  a: "a.push(1);",
  B: "const b = buildB(inputB);",
  b: "b.push(2);",
  E: PRIOR_EFFECT,
};

export const PRIOR_UPDATES = [
  { label: "mount", inputA: [2, 3], inputB: [4, 5] },
  { label: "stable", inputA: [2, 3], inputB: [4, 5] },
  { label: "onlyA", inputA: [7, 8], inputB: [4, 5] },
  { label: "stableA", inputA: [7, 8], inputB: [4, 5] },
  { label: "onlyB", inputA: [7, 8], inputB: [9, 10] },
  { label: "stableAB", inputA: [7, 8], inputB: [9, 10] },
  { label: "both", inputA: [11, 12], inputB: [13, 14] },
  { label: "stableBoth", inputA: [11, 12], inputB: [13, 14] },
  { label: "onlyBRevert", inputA: [11, 12], inputB: [9, 10] },
];

export function binaryTransitionWalk(roots, seed) {
  const vertices = 2 ** roots;
  const next = random(seed);
  const remaining = Array.from({ length: vertices }, () => {
    const adjacent = Array.from({ length: vertices }, (_, index) => index);
    for (let index = adjacent.length - 1; index > 0; index--) {
      const other = Math.floor(next() * (index + 1));
      [adjacent[index], adjacent[other]] = [adjacent[other], adjacent[index]];
    }
    return adjacent;
  });
  const stack = [0];
  const walk = [];
  while (stack.length) {
    const current = stack.at(-1);
    if (remaining[current].length) stack.push(remaining[current].pop());
    else walk.push(stack.pop());
  }
  return walk.reverse();
}

export function scalarUpdates(seed, roots = 2) {
  const next = random(seed);
  const x = 2 + Math.floor(next() * 5);
  const y = 13 + Math.floor(next() * 5);
  const z = 31 + Math.floor(next() * 5);
  const walk = binaryTransitionWalk(roots, seed);
  return walk.map((vertex, index) => ({
    label: index === 0 ? "mount" : `${walk[index - 1]}->${vertex}@${index}`,
    inputA: x + (vertex & 1 ? 3 : 0),
    inputB: y + (vertex & 2 ? 5 : 0),
    inputC: z + ((roots === 3 ? vertex & 4 : index % 2) ? 7 : 0),
    unrelated: index,
  }));
}

const REGION_KINDS = {
  arrays: (name, input) => [`const ${name} = [];`, `${name}.push(${input});`],
  objects: (name, input) => [`const ${name} = {};`, `${name}.value = ${input};`],
  "object-props": (name, input) => [
    `const ${name} = {value: ${input}};`,
    `${name}.double = ${input} * 2;`,
  ],
  closures: (name, input) => [
    `const read${name} = () => ${input};`,
    `const ${name} = {read: read${name}};`,
  ],
  helpers: (name, input) => [
    `const make${name} = (value) => ({value});`,
    `const ${name} = make${name}(${input});`,
  ],
  aliases: (name, input) => [
    `const ${name} = [];`,
    `const alias${name} = ${name};`,
    `alias${name}.push(${input});`,
  ],
  "multi-write": (name, input) => [
    `const ${name} = [];`,
    `${name}.push(${input});`,
    `${name}.push(${input} + 1);`,
  ],
  "primitive-read": (name, input) => [
    `const items${name} = [];`,
    `items${name}.push(${input});`,
    `const ${name} = {value: items${name}[0], length: items${name}.length};`,
  ],
};

export const FAMILIES = [
  { name: "arrays-2-h1", kind: "arrays", regions: 2, hooks: 1, requiredGoal: true },
  { name: "arrays-2-h2", kind: "arrays", regions: 2, hooks: 2, requiredGoal: true },
  { name: "objects-2-h1", kind: "objects", regions: 2, hooks: 1, requiredGoal: true },
  { name: "objects-2-h2", kind: "objects", regions: 2, hooks: 2, requiredGoal: true },
  { name: "object-props-2-h1", kind: "object-props", regions: 2, hooks: 1, requiredGoal: false },
  { name: "closures-2-h1", kind: "closures", regions: 2, hooks: 1, requiredGoal: false },
  { name: "closures-2-h2", kind: "closures", regions: 2, hooks: 2, requiredGoal: false },
  { name: "helpers-2-h1", kind: "helpers", regions: 2, hooks: 1, requiredGoal: false },
  { name: "aliases-2-h1", kind: "aliases", regions: 2, hooks: 1, requiredGoal: false },
  { name: "multi-write-2-h1", kind: "multi-write", regions: 2, hooks: 1, requiredGoal: false },
  {
    name: "primitive-read-2-h1",
    kind: "primitive-read",
    regions: 2,
    hooks: 1,
    requiredGoal: false,
  },
  { name: "arrays-3-h1", kind: "arrays", regions: 3, hooks: 1, requiredGoal: true },
  { name: "arrays-3-h2", kind: "arrays", regions: 3, hooks: 2, requiredGoal: true },
];

export function familyGraph(family) {
  const statements = {};
  const chains = [];
  for (let index = 0; index < family.regions; index++) {
    const name = "abc"[index];
    const tokens = REGION_KINDS[family.kind](name, `input${name.toUpperCase()}`);
    chains.push(
      tokens.map((statement, operation) => {
        const token = `${name}${operation}`;
        statements[token] = statement;
        return token;
      }),
    );
  }
  chains.push(
    Array.from({ length: family.hooks }, (_, index) => {
      const token = `E${index + 1}`;
      statements[token] =
        `useEffect(() => { observe("setup:${token}"); return () => observe("cleanup:${token}"); }, []);`;
      return token;
    }),
  );
  return { statements, chains };
}

function regionExpected(kind, input, raw) {
  switch (kind) {
    case "arrays":
    case "aliases":
      return [input];
    case "multi-write":
      return [input, input + 1];
    case "object-props":
      return { value: input, double: input * 2 };
    case "closures":
      return { read: raw ? "<function>" : input };
    case "primitive-read":
      return { value: input, length: 1 };
    default:
      return { value: input };
  }
}

function generatedCase(task) {
  const family = FAMILIES.find((entry) => entry.name === task.family);
  assert(family, `Unknown family: ${task.family}`);
  const { statements, chains } = familyGraph(family);
  assert(legalSchedule(task.schedule, chains));
  const names = [..."abc"].slice(0, family.regions);
  const expected = (input, raw = false) =>
    Object.fromEntries(
      names.map((name) => [
        name,
        regionExpected(family.kind, input[`input${name.toUpperCase()}`], raw),
      ]),
    );
  return {
    component: true,
    source: source(
      task.schedule.map((token) => statements[token]).join("\n"),
      `{${names.join(", ")}}`,
    ),
    updates: scalarUpdates(task.seed, family.regions),
    expected,
    fields: names,
    distinct: names,
    retain: true,
    hooks: Array(family.hooks).fill("useEffect"),
    effects: Array.from({ length: family.hooks }, (_, index) => ({
      name: `E${index + 1}`,
      dependency: "mount",
    })),
    cache: { SchedulingProbe: family.requiredGoal ? "enabled-required" : "preserve" },
    goal: {
      required: family.requiredGoal,
      dependencies: Object.fromEntries(names.map((name) => [name, [`input${name.toUpperCase()}`]])),
      result: true,
    },
  };
}

function priorCase(task) {
  const expected = ({ inputA, inputB }) => ({ a: [...inputA, 1], b: [...inputB, 2] });
  return {
    source: priorSource(task.schedule.map((token) => PRIOR_STATEMENTS[token]).join("\n")),
    updates: PRIOR_UPDATES,
    internArrays: true,
    expected,
    fields: ["a", "b"],
    distinct: ["a", "b"],
    retain: true,
    hooks: ["useEffect"],
    effects: [{ name: "", dependency: "mount" }],
    cache: { useSchedulingProbe: "required" },
    goal: { required: false, dependencies: { a: ["inputA"], b: ["inputB"] }, result: true },
    priorCounters: task.schedule.join("") === "AaBbE",
  };
}

function control(name, seed) {
  const updates = scalarUpdates(seed);
  const standard = {
    component: true,
    updates,
    fields: ["a", "b"],
    distinct: ["a", "b"],
    retain: true,
    hooks: ["useEffect"],
    effects: [{ name: "E1", dependency: "mount" }],
    cache: { SchedulingProbe: "preserve" },
  };
  const effect =
    'useEffect(() => { observe("setup:E1"); return () => observe("cleanup:E1"); }, []);';
  const arrays = ({ inputA, inputB }) => ({ a: [inputA], b: [inputB] });
  switch (name) {
    case "unnamed-getter-order":
    case "throwing-getter-order":
    case "unnamed-call-order":
    case "const-bound-call-order":
    case "typecast-getter-order": {
      const calls = name.includes("call");
      const casts = name.includes("typecast");
      const bound = name.startsWith("const-bound");
      const left = calls ? "left()" : "left.value";
      const right = calls ? "right()" : "right.value";
      const statements = bound
        ? `const x = ${left}; const y = ${right}; const a = [x]; const b = [y];`
        : `const a = [${left}${casts ? " as number" : ""}]; const b = [${right}${casts ? " as number" : ""}];`;
      const text = `export default function Component({left, right}) { ${statements} const n = b[0]; return a[0] + n; }`;
      const throwing = name === "throwing-getter-order";
      return {
        ...standard,
        source: text,
        sourceWithoutTypes: casts ? text.replaceAll(" as number", "") : undefined,
        lang: casts ? "ts" : "js",
        compilationMode: "all",
        scalarComponent: true,
        updates: [
          {
            label: "first-mount",
            inputA: 2,
            inputB: 7,
            ...(throwing ? { throwLeft: true, throwRight: true, error: "left-error" } : {}),
          },
        ],
        expected: ({ inputA, inputB }) => ({ value: String(inputA + inputB) }),
        external: calls ? "anchor-calls" : "anchor-getters",
        expectedEvents: throwing
          ? ["get:left"]
          : [`${calls ? "call" : "get"}:left`, `${calls ? "call" : "get"}:right`],
        eventsPerAttempt: true,
        errorBoundary: throwing,
        fields: [],
        distinct: [],
        hooks: [],
        effects: [],
        cache: { Component: "preserve" },
        assumption:
          "Strict first-mount execution-order regression for anchored unnamed operands. M0/M1 isolate instruction movement; throwing getters independently determine the first exception.",
      };
    }
    case "unknown-read":
      return {
        ...standard,
        source: source(
          `const a = [];\nconst b = [];\nconst before = snapshot(a);\na.push(inputA);\n${effect}\nb.push(inputB);\nconst after = snapshot(a);`,
          "{a, b, before, after}",
        ),
        expected: (input) => ({ ...arrays(input), before: [], after: [input.inputA] }),
      };
    case "unknown-mutation":
      return {
        ...standard,
        source: source(
          `const a = [];\nconst b = [];\nmutate(a, inputA);\n${effect}\nb.push(inputB);\nmutate(a, inputB);`,
        ),
        expected: ({ inputA, inputB }) => ({ a: [inputA, inputB], b: [inputB] }),
      };
    case "escaped-alias":
      return {
        ...standard,
        source: source(
          `const a = [];\nconst read = capture(a);\nconst b = [];\n${effect}\na.push(inputA);\nb.push(inputB);`,
          "{a, b, read}",
        ),
        expected: (input, raw) => ({ ...arrays(input), read: raw ? "<function>" : [input.inputA] }),
      };
    case "alias-read-write":
      return {
        ...standard,
        source: source(
          `const a = [];\nconst alias = a;\nconst b = [];\na.push(inputA);\nconst before = alias.length;\n${effect}\nalias.push(inputB);\nb.push(before);`,
          "{a, b, alias, before}",
        ),
        expected: ({ inputA, inputB }) => ({
          a: [inputA, inputB],
          b: [1],
          alias: [inputA, inputB],
          before: 1,
        }),
        aliases: [["a", "alias"]],
      };
    case "correlated-dependencies":
      return {
        ...standard,
        source: source(
          `const a = [];\nconst b = [];\na.push(inputA + inputB);\n${effect}\nb.push(inputA - inputB);`,
        ),
        expected: ({ inputA, inputB }) => ({ a: [inputA + inputB], b: [inputA - inputB] }),
        goal: {
          required: false,
          dependencies: { a: ["inputA", "inputB"], b: ["inputA", "inputB"] },
          result: true,
        },
      };
    case "getter":
    case "proxy":
      return {
        ...standard,
        source: source(
          `const a = [];\nconst b = [];\na.push(data.left);\n${effect}\nb.push(data.right);`,
        ),
        expected: arrays,
        external: name,
        expectedEvents: ["get:left", "get:right"],
        assumption:
          "Adversarial accessor event counts; compiler purity assumptions may already differ from JavaScript.",
      };
    case "computed-key-coercion":
      return {
        ...standard,
        source: source(
          `const a = {};\nconst b = {};\na[data.left] = inputA;\n${effect}\nb[data.right] = inputB;`,
        ),
        expected: ({ inputA, inputB }) => ({ a: { value: inputA }, b: { value: inputB } }),
        external: "coercion",
        expectedEvents: ["key:left", "key:right"],
      };
    case "spread-iterator":
      return {
        ...standard,
        source: source(
          `const a = [];\nconst b = [];\na.push(...data.left);\n${effect}\nb.push(...data.right);`,
        ),
        expected: arrays,
        external: "iterator",
        expectedEvents: ["iterate:left", "iterate:right"],
      };
    case "early-return-throw":
      return {
        ...standard,
        source: source(
          `${effect}\nif (!visible) return <CommitObserver value={{a: null, b: null}} />;\nconst a = [];\nconst b = [];\na.push(mayThrow(inputA));\nb.push(inputB);`,
        ),
        updates: [
          { label: "hidden-negative", inputA: -1, inputB: 3, visible: false },
          { label: "visible", inputA: 2, inputB: 3, visible: true },
          { label: "hide-negative", inputA: -2, inputB: 4, visible: false },
          { label: "show", inputA: 5, inputB: 4, visible: true },
        ],
        distinct: [],
        expected: (input) => (input.visible ? arrays(input) : { a: null, b: null }),
      };
    case "throwing-work":
      return {
        ...standard,
        source: source(
          `const a = [];\n${effect}\nconst value = mayThrow(inputA);\nconst b = [];\na.push(value);\nb.push(inputB);`,
        ),
        updates: [
          { label: "mount", inputA: 2, inputB: 3 },
          { label: "throw", inputA: -1, inputB: 3, error: "negative:-1" },
          { label: "recover", inputA: 4, inputB: 5, reset: true },
          { label: "stable", inputA: 4, inputB: 5 },
        ],
        expected: arrays,
        errorBoundary: true,
      };
    case "dependent-state":
      return {
        ...standard,
        source: source(
          `const a = [];\nconst b = [];\nconst [count] = useState(a.length);\na.push(inputA, count);\n${effect}\nb.push(inputB);`,
        ),
        expected: ({ inputA, inputB }) => ({ a: [inputA, 0], b: [inputB] }),
        hooks: ["useState", "useEffect"],
        hookArguments: [{ name: "useState", value: 0 }],
      };
    case "hook-cycle":
      return {
        ...standard,
        source: source(
          `const a = [];\nconst b = [];\nconst [n] = useState(a.length);\na.push(n);\n${effect}\nb.push(inputB);`,
        ),
        expected: ({ inputB }) => ({ a: [0], b: [inputB] }),
        hooks: ["useState", "useEffect"],
        hookArguments: [{ name: "useState", value: 0 }],
      };
    case "same-kind-state-sites":
      return {
        ...standard,
        source: source(
          `const [left, setLeft] = useState(3);\nconst a = [];\nconst [right, setRight] = useState(17);\nconst b = [];\na.push(left);\n${effect}\nb.push(right);\nconst incrementLeft = () => setLeft(value => value + 2);\nconst incrementRight = () => setRight(value => value + 5);`,
          "{a, b, incrementLeft, incrementRight}",
        ),
        updates: [
          { label: "mount", left: 3, right: 17 },
          { label: "left", action: "incrementLeft", left: 5, right: 17 },
          { label: "right", action: "incrementRight", left: 5, right: 22 },
          { label: "left-again", action: "incrementLeft", actionFrom: "mount", left: 7, right: 22 },
        ],
        expected: ({ left, right }) => ({
          a: [left],
          b: [right],
          incrementLeft: "<function>",
          incrementRight: "<function>",
        }),
        hooks: ["useState", "useState", "useEffect"],
        hookSiteArguments: [3, 17],
        actionFields: ["incrementLeft", "incrementRight"],
      };
    case "shared-inner":
      return {
        ...standard,
        source: source(
          `const inner = {value: inputA};\nconst a = [];\nconst b = [];\na.push(inner);\nconst before = inner.value;\n${effect}\ninner.value += inputB;\nb.push(inner);`,
          "{a, b, before}",
        ),
        expected: ({ inputA, inputB }) => ({
          a: [{ value: inputA + inputB }],
          b: [{ value: inputA + inputB }],
          before: inputA,
        }),
        aliases: [["a.0", "b.0"]],
      };
    case "intermediate-equality":
      return {
        ...standard,
        source: source(
          `const length = inputA.length;\nconst a = [];\nconst b = [];\na.push(length);\n${effect}\nb.push(inputB);`,
        ),
        updates: [
          { label: "mount", inputA: [1, 2], inputB: 3 },
          { label: "same-length-new-array", inputA: [7, 8], inputB: 3 },
          { label: "new-length", inputA: [7], inputB: 3 },
          { label: "new-b", inputA: [7], inputB: 5 },
          { label: "revert-length", inputA: [1, 2], inputB: 5 },
        ],
        internArrays: true,
        expected: ({ inputA, inputB }) => ({ a: [inputA.length], b: [inputB] }),
        goal: {
          required: false,
          dependencies: { a: ["inputA.length"], b: ["inputB"] },
          result: true,
        },
      };
    case "special-primitives":
      return {
        ...standard,
        source: source(
          `const a = [];\nconst b = {};\na.push(inputA);\n${effect}\nb.value = inputB;\nconst holes = [, inputA];`,
          "{a, b, holes}",
        ),
        updates: [
          { label: "negative-zero", inputA: -0, inputB: undefined },
          { label: "positive-zero", inputA: 0, inputB: undefined },
          { label: "NaN", inputA: NaN, inputB: null },
          { label: "NaN-stable", inputA: NaN, inputB: null },
          { label: "undefined", inputA: undefined, inputB: -0 },
        ],
        expected: ({ inputA, inputB }) => {
          const holes = Array(2);
          holes[1] = inputA;
          return { a: [inputA], b: { value: inputB }, holes };
        },
      };
    case "dependent-effect":
      return {
        ...standard,
        source: source(
          `const a = [];\nconst b = [];\na.push(inputA);\nuseEffect(() => { observe("setup:A:" + a.join(",")); return () => observe("cleanup:A:" + a.join(",")); }, [a]);\nb.push(inputB);`,
        ),
        expected: arrays,
        effects: [{ name: "A", dependency: "a", value: (input) => String(input.inputA) }],
      };
    case "effect-before-write":
      return {
        ...standard,
        source: source(
          `const a = [];\nconst b = [];\nuseEffect(() => { observe("setup:A:" + a.join(",")); return () => observe("cleanup:A:" + a.join(",")); }, [a]);\na.push(inputA);\nb.push(inputB);`,
        ),
        expected: arrays,
        effects: [{ name: "A", dependency: "a", value: (input) => String(input.inputA) }],
      };
    case "loop":
      return {
        ...standard,
        source: source(
          `const a = [];\nconst b = [];\n${effect}\nfor (let index = 0; index < 3; index++) { a.push(inputA + index); b.push(inputB + index); }`,
        ),
        expected: ({ inputA, inputB }) => ({
          a: [inputA, inputA + 1, inputA + 2],
          b: [inputB, inputB + 1, inputB + 2],
        }),
      };
    case "positive-loop-work":
      return {
        ...standard,
        source: source(
          "const rows = [];\nuseState(0);\nfor (let i = 0; i < inputA.length; i++) rows.push({i, value: inputA[i]});",
          "{rows}",
        ),
        updates: [
          { label: "mount", inputA: [2, 3], inputB: 1 },
          { label: "stable-unrelated-change", inputA: [2, 3], inputB: 2 },
          { label: "changed-values", inputA: [5, 8], inputB: 2 },
          { label: "stable", inputA: [5, 8], inputB: 2 },
          { label: "shorter", inputA: [5], inputB: 2 },
          { label: "empty", inputA: [], inputB: 2 },
          { label: "empty-stable", inputA: [], inputB: 2 },
        ],
        internArrays: true,
        expected: ({ inputA }) => ({ rows: inputA.map((value, i) => ({ i, value })) }),
        fields: ["rows"],
        distinct: [],
        hooks: ["useState"],
        effects: [],
        cache: { SchedulingProbe: "enabled-required" },
        goal: { required: true, dependencies: { rows: ["inputA"] }, result: true },
      };
    case "captured-mutable":
      return {
        ...standard,
        source: source(
          `let value = inputA;\nconst a = () => value;\nconst b = [];\n${effect}\nvalue += inputB;\nb.push(inputB);`,
        ),
        expected: ({ inputA, inputB }, raw) => ({
          a: raw ? "<function>" : inputA + inputB,
          b: [inputB],
        }),
      };
    case "captured-alias":
      return {
        ...standard,
        source: source(
          `const values = [];\nconst alias = values;\nconst a = () => alias[0];\nconst b = [];\nvalues.push(inputA);\n${effect}\nb.push(inputB);`,
        ),
        expected: ({ inputA, inputB }, raw) => ({ a: raw ? "<function>" : inputA, b: [inputB] }),
      };
    case "ref-effect":
      return {
        ...standard,
        source: source(
          `const ref = useRef(0);\nconst a = [];\nconst b = [];\nuseEffect(() => { ref.current = inputA; }, [inputA]);\na.push(inputA);\nb.push(inputB);\nconst read = () => ref.current;`,
          "{a, b, read}",
        ),
        expected: (input, raw) => ({ ...arrays(input), read: raw ? "<function>" : input.inputA }),
        hooks: ["useRef", "useEffect"],
        effects: [],
        retain: false,
      };
    case "manual-memo":
      return {
        ...standard,
        source: source(
          `const a = useMemo(() => ({value: inputA}), [inputA]);\n${effect}\nconst b = useCallback(() => inputB, [inputB]);`,
        ),
        expected: ({ inputA, inputB }, raw) => ({
          a: { value: inputA },
          b: raw ? "<function>" : inputB,
        }),
        hooks: ["useMemo", "useEffect", "useCallback"],
        optionalCompiledHooks: ["useMemo", "useCallback"],
        manualIdentity: { a: ["inputA"], b: ["inputB"] },
      };
    case "use-resource":
      return {
        ...standard,
        source: source(
          `const a = [];\nconst b = [];\na.push(inputA);\nconst value = use(resource);\na.push(value);\n${effect}\nb.push(inputB);`,
        ),
        updates: [
          { label: "pending", inputA: 2, inputB: 3, resource: "pending", suspended: true },
          { label: "resolve", inputA: 2, inputB: 3, resource: "pending", resolve: 11 },
          { label: "stable", inputA: 2, inputB: 3, resource: "pending" },
          { label: "change", inputA: 5, inputB: 7, resource: "pending" },
        ],
        expected: ({ inputA, inputB }) => ({ a: [inputA, 11], b: [inputB] }),
        hooks: ["use", "useEffect"],
        suspense: true,
      };
    case "state-updates":
      return {
        ...standard,
        source: source(
          `const [count, setCount] = useState(0);\nconst a = [];\nconst b = [];\na.push(inputA + count);\n${effect}\nb.push(inputB);\nconst increment = () => setCount(value => value + 1);`,
          "{a, b, increment, count}",
        ),
        updates: [
          { label: "mount", inputA: 2, inputB: 3, count: 0 },
          { label: "increment", action: "increment", inputA: 2, inputB: 3, count: 1 },
          { label: "increment-again", action: "increment", inputA: 2, inputB: 3, count: 2 },
          { label: "new-props", inputA: 7, inputB: 3, count: 2 },
          {
            label: "retained-handler",
            action: "increment",
            actionFrom: "mount",
            inputA: 7,
            inputB: 3,
            count: 3,
          },
        ],
        expected: ({ inputA, inputB, count }) => ({
          a: [inputA + count],
          b: [inputB],
          increment: "<function>",
          count,
        }),
        actionFields: ["increment"],
        hooks: ["useState", "useEffect"],
      };
    case "strict-effects":
      return { ...control("dependent-effect", seed), strict: true, retain: false };
    case "remount":
      return {
        ...standard,
        source: source(`const a = [];\nconst b = [];\na.push(inputA);\n${effect}\nb.push(inputB);`),
        updates: updates.slice(0, 5).map((input, index) => ({ ...input, remount: index === 3 })),
        expected: arrays,
      };
    case "suspense-abandon":
      return {
        ...control("use-resource", seed),
        updates: [
          {
            label: "pending-abandon",
            inputA: 2,
            inputB: 3,
            resource: "abandoned",
            suspended: true,
          },
          {
            label: "replace-pending",
            inputA: 5,
            inputB: 7,
            resource: "replacement",
            suspended: true,
          },
          {
            label: "resolve-replacement",
            inputA: 5,
            inputB: 7,
            resource: "replacement",
            resolve: 11,
          },
          {
            label: "resolve-abandoned",
            inputA: 5,
            inputB: 7,
            resource: "replacement",
            resolveOther: "abandoned",
          },
          { label: "stable", inputA: 5, inputB: 7, resource: "replacement" },
        ],
      };
    case "diagnostic-isolation":
      return {
        ...standard,
        component: false,
        source: `import {useState} from 'react';
export function useValidProbe({inputA}) { const a = []; a.push(inputA); return {a}; }
export function useOptOutProbe({inputA}) { "use no memo"; return {a: [inputA]}; }
export function useInvalidProbe({visible}) { if (visible) { useState(0); } return visible; }
export default useValidProbe;`,
        expected: ({ inputA }) => ({ a: [inputA] }),
        fields: ["a"],
        distinct: [],
        hooks: [],
        effects: [],
        cache: {
          useValidProbe: "preserve",
          useOptOutProbe: "forbidden",
          useInvalidProbe: "forbidden",
        },
        diagnostic: { required: true, pattern: "hook" },
        assumption:
          "A recoverable invalid-hook diagnostic can cause a whole-module no-cache fallback; the clean cache-isolation control requires the valid function to compile.",
      };
    case "cache-isolation":
      return {
        ...standard,
        component: false,
        source: `import {useState} from 'react';
export function useValidProbe({inputA}) { useState(0); const a = []; a.push(inputA); return {a}; }
export function useOptOutProbe({inputA}) { "use no memo"; return {a: [inputA]}; }
export default useValidProbe;`,
        expected: ({ inputA }) => ({ a: [inputA] }),
        fields: ["a"],
        distinct: [],
        hooks: ["useState"],
        effects: [],
        cache: { useValidProbe: "required", useOptOutProbe: "forbidden" },
      };
    case "diagnostic-ref":
      return {
        ...standard,
        component: false,
        source: `import {useRef} from 'react';
export default function useSchedulingProbe() { const ref = useRef(0); return {value: ref.current}; }`,
        compileOnly: true,
        diagnostic: { required: true, pattern: "ref" },
        cache: { useSchedulingProbe: "forbidden" },
      };
    case "prior-demand-guarded":
    case "prior-demand-hoisted": {
      const calculation = "const value = expensive(inputA);";
      const guard = "if (!visible) { return {value: null}; }";
      return {
        ...standard,
        component: false,
        source: priorSource(
          `${PRIOR_EFFECT}\n${name.endsWith("guarded") ? `${guard}\n${calculation}` : `${calculation}\n${guard}`}`,
          "{value}",
        ),
        updates: [
          { label: "hidden-mount", inputA: [2, 3], visible: false },
          { label: "hidden-new-input", inputA: [7, 8], visible: false },
          { label: "show", inputA: [7, 8], visible: true },
          { label: "visible-stable", inputA: [7, 8], visible: true },
          { label: "hide-new-input", inputA: [11, 12], visible: false },
          { label: "show-new-input", inputA: [11, 12], visible: true },
        ],
        internArrays: true,
        fields: [],
        distinct: [],
        effects: [{ name: "", dependency: "mount" }],
        expected: ({ inputA, visible }) => ({
          value: visible ? inputA.reduce((sum, value) => sum + value, 0) : null,
        }),
      };
    }
    case "prior-dependent-state":
      return {
        ...standard,
        component: false,
        source: priorSource(
          `const a = buildA(inputA);\nconst [count] = useState(a.length);\na.push(count);\n${PRIOR_EFFECT}`,
          "{a}",
        ),
        updates: [
          ...PRIOR_UPDATES,
          { label: "differentLength", inputA: [15, 16, 17], inputB: [9, 10] },
        ],
        internArrays: true,
        expected: ({ inputA }) => ({ a: [...inputA, 2] }),
        fields: ["a"],
        distinct: [],
        hooks: ["useState", "useEffect"],
        effects: [{ name: "", dependency: "mount" }],
      };
    case "prior-immutable-state":
      return {
        ...control("prior-dependent-state", seed),
        source: priorSource(
          `const prepared = buildA(inputA);\nconst [count] = useState(prepared.length);\nconst a = [...prepared, count];\n${PRIOR_EFFECT}`,
          "{a}",
        ),
      };
    case "prior-dependent-effect-grouped":
    case "prior-dependent-effect-interleaved":
      return {
        ...standard,
        component: false,
        source: priorSource(
          `${[...(name.endsWith("grouped") ? "AaBb" : "ABab")].map((token) => PRIOR_STATEMENTS[token]).join("\n")}\nuseEffect(() => { observe("setup:" + a.join(",")); return () => observe("cleanup:" + a.join(",")); }, [a]);`,
        ),
        updates: PRIOR_UPDATES,
        internArrays: true,
        expected: ({ inputA, inputB }) => ({ a: [...inputA, 1], b: [...inputB, 2] }),
        effects: [{ name: "", dependency: "a", value: ({ inputA }) => [...inputA, 1].join(",") }],
      };
    case "prior-primitive-opaque":
    case "prior-primitive-explicit":
      return {
        ...standard,
        component: false,
        source: priorSource(
          `${PRIOR_EFFECT}\nconst intermediate = ${name.endsWith("explicit") ? "!!" : ""}cheap(inputA);\nconst value = expensive(intermediate);`,
          "{value}",
        ),
        updates: [
          ...PRIOR_UPDATES,
          { label: "empty", inputA: [] },
          { label: "empty-stable", inputA: [] },
          { label: "nonempty-again", inputA: [11, 12] },
        ],
        internArrays: true,
        expected: ({ inputA }) => ({ value: inputA.length > 0 ? "positive" : "empty" }),
        fields: [],
        distinct: [],
        effects: [{ name: "", dependency: "mount" }],
      };
    default:
      throw new Error(`Unknown control: ${name}`);
  }
}

export const CONTROL_NAMES = [
  "unnamed-getter-order",
  "throwing-getter-order",
  "unnamed-call-order",
  "const-bound-call-order",
  "typecast-getter-order",
  "unknown-read",
  "unknown-mutation",
  "escaped-alias",
  "alias-read-write",
  "correlated-dependencies",
  "getter",
  "proxy",
  "computed-key-coercion",
  "spread-iterator",
  "early-return-throw",
  "throwing-work",
  "dependent-state",
  "hook-cycle",
  "same-kind-state-sites",
  "shared-inner",
  "intermediate-equality",
  "special-primitives",
  "dependent-effect",
  "effect-before-write",
  "loop",
  "positive-loop-work",
  "captured-mutable",
  "captured-alias",
  "ref-effect",
  "manual-memo",
  "use-resource",
  "diagnostic-isolation",
  "cache-isolation",
  "diagnostic-ref",
  "prior-demand-guarded",
  "prior-demand-hoisted",
  "prior-dependent-state",
  "prior-immutable-state",
  "prior-dependent-effect-grouped",
  "prior-dependent-effect-interleaved",
  "prior-primitive-opaque",
  "prior-primitive-explicit",
];

export const LIFECYCLE_NAMES = {
  state: "state-updates",
  strict: "strict-effects",
  remount: "remount",
  suspense: "suspense-abandon",
};

export function buildCase(task) {
  if (task.kind === "generated") return generatedCase(task);
  if (task.kind === "prior") return priorCase(task);
  return control(task.name, task.seed);
}

export function canaryTask(seed) {
  return {
    id: "canary/fresh-arrays-interleaved",
    kind: "generated",
    family: "arrays-2-h1",
    schedule: ["a0", "b0", "a1", "b1", "E1"],
    seed,
  };
}

export function generateSuite({
  mode = "short",
  seed = DEFAULT_SEED,
  threeRegionLimit = 256,
  lifecycle = [],
} = {}) {
  assert(MODES.includes(mode), `Unknown mode: ${mode}`);
  const tasks = [];
  const coverage = [];
  for (const family of FAMILIES) {
    const { chains } = familyGraph(family);
    const possible = scheduleCount(chains);
    const smallCompleteFamily = family.regions === 2 && chains[0].length === 2;
    const limit =
      mode === "short"
        ? smallCompleteFamily
          ? possible
          : 8
        : family.regions === 3
          ? threeRegionLimit
          : possible;
    const schedules = chooseSchedules(chains, limit, hash(family.name, seed));
    coverage.push({
      family: family.name,
      possible,
      selected: schedules.length,
      bounded: schedules.length < possible,
      requiredGoal: family.requiredGoal,
    });
    for (const schedule of schedules) {
      tasks.push({
        id: `${family.name}/${schedule.join("-")}`,
        kind: "generated",
        family: family.name,
        schedule,
        seed,
      });
    }
  }
  const priorChains = [["A", "a"], ["B", "b"], ["E"]];
  const priorSchedules = chooseSchedules(priorChains, 30, hash("prior", seed));
  coverage.push({
    family: "prior-exact",
    possible: 30,
    selected: priorSchedules.length,
    bounded: priorSchedules.length < 30,
    requiredGoal: false,
  });
  for (const schedule of priorSchedules)
    tasks.push({
      id: `prior-exact/${schedule.join("")}`,
      family: "prior-exact",
      kind: "prior",
      schedule,
      seed,
    });
  for (const name of CONTROL_NAMES)
    tasks.push({ id: `control/${name}`, family: "control", kind: "control", name, seed });
  for (const selection of lifecycle) {
    assert(selection in LIFECYCLE_NAMES, `Unknown lifecycle mode: ${selection}`);
    const name = LIFECYCLE_NAMES[selection];
    tasks.push({ id: `lifecycle/${name}`, family: "lifecycle", kind: "control", name, seed });
  }
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
  return { tasks, coverage };
}
