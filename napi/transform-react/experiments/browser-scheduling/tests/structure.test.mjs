import assert from "node:assert/strict";
import { test } from "node:test";
import { stateHookEvidence, structuralEvidence, suspensionMotionEvidence } from "../structure.mjs";

const left = "const [left, setLeft] = s(2);";
const right = "const [right, setRight] = s(30);";
const stateModule = (body) => `import {useState as s} from 'react'; export function Component() { ${body} return null; }`;

test("hook evidence binds initializer identities to unconditional emitted callsites", () => {
  assert.equal(stateHookEvidence(stateModule(`${left} ${right}`)).passed, true);
  assert.equal(stateHookEvidence(stateModule(`${right} ${left}`)).passed, false);
  assert.equal(stateHookEvidence(stateModule("const [left, setLeft] = s(30); const [right, setRight] = s(2);")).passed, false);
  assert.equal(stateHookEvidence(stateModule(`if (flag) { ${left} } ${right}`)).passed, false);
});

test("hook-like names in comments and uncalled nested functions cannot satisfy evidence", () => {
  assert.equal(stateHookEvidence(stateModule(`// ${left}\n function ignored() { ${left} } ${right}`)).passed, false);
});

const before = `import {use, useState} from 'react'; export function Component({resource}) {
  const rows = []; const [local, setLocal] = useState(3);
  const payload = use(resource.promise); rows.push(payload); return null;
}`;
const after = `import {use, useState} from 'react'; export function Component({resource}) {
  const [local, setLocal] = useState(3); const payload = use(resource.promise);
  const rows = []; rows.push(payload); return null;
}`;
const records = (scheduled) => [
  ...["U", "B", "S", "M0", "M1"].map((mode) => ({ fixture: "state", mode, code: stateModule(`${left} ${right}`) })),
  ...["B", "S", "M0", "M1"].map((mode) => ({ fixture: "transition-motion", mode, code: mode === "S" || mode === "M1" ? scheduled : before })),
];

test("concurrent motion requires the actual allocation to cross the use call", () => {
  assert.equal(structuralEvidence(records(after)).passed, true);
  assert.equal(structuralEvidence(records(`${before}\n// different output hash`)).passed, false);
  assert.deepEqual(suspensionMotionEvidence(after).events.map((event) => event.kind), [
    "useState(3)", "use(resource.promise)", "allocate-rows", "rows.push(payload)",
  ]);
});

test("an array in a nested closure is not the emitted render allocation", () => {
  assert.equal(suspensionMotionEvidence(after.replace("const rows = [];", "const rows = makeRows(); function makeRows() { return []; }")).passed, false);
});
