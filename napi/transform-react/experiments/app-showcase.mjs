// Adapted from the controlled LegalNameStep validation in Expensify/eslint-config-expensify PR 212.
// This experiment compiles identical pinned App source with scheduling disabled/enabled.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runInThisContext } from "node:vm";

const { values } = parseArgs({
  options: { app: { type: "string" }, binding: { type: "string" }, output: { type: "string" } },
});
assert(
  values.app,
  "Pass --app /path/to/App with installed React, renderer and esbuild dependencies",
);
const app = path.resolve(values.app);
const binding = path.resolve(
  values.binding ?? fileURLToPath(new URL("../index.js", import.meta.url)),
);
const { transformSync } = await import(pathToFileURL(binding));
const requireApp = createRequire(path.join(app, "package.json"));
const React = requireApp("react");
const { act, create } = requireApp("react-test-renderer");
const esbuild = requireApp("esbuild");
assert.equal(React.version, "19.2.3");
assert.equal(requireApp("react-test-renderer/package.json").version, React.version);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const base = "df1e765feee11ea8983554979da24405a4b39411";
const filename = "src/pages/AddPersonalBankAccountPage/substeps/LegalNameStep.tsx";
const sourceAtBase = (file) =>
  execFileSync("git", ["show", `${base}:${file}`], { cwd: app, encoding: "utf8" });
const hash = (source) => createHash("sha256").update(source).digest("hex");
const configSource = sourceAtBase("config/babel/oxcReactCompilerConfig.js");
const configModule = { exports: {} };
runInThisContext("(function(module) {\n" + configSource + "\n})")(configModule);
const config = configModule.exports();
const source = sourceAtBase(filename);
const modes = {
  source: false,
  baseline: { ...config, reportDiagnostics: true },
  scheduled: {
    ...config,
    reportDiagnostics: true,
    environment: { ...config.environment, enableInstructionReordering: true },
  },
  motionBaseline: {
    ...config,
    reportDiagnostics: true,
    environment: { ...config.environment, disableMemoizationForTesting: true },
  },
  motionScheduled: {
    ...config,
    reportDiagnostics: true,
    environment: {
      ...config.environment,
      enableInstructionReordering: true,
      disableMemoizationForTesting: true,
    },
  },
};

function compile(input, file, options) {
  const result = transformSync(file, input, {
    lang: file.endsWith(".tsx") ? "tsx" : "ts",
    reactCompiler: options,
  });
  assert.equal(result.fatal, false, file);
  assert.deepEqual(result.errors, [], file);
  return result.code;
}

function evaluate(code, imports) {
  const cjs = esbuild.transformSync(code, { format: "cjs" }).code;
  const module = { exports: {} };
  runInThisContext("(function(require,module,exports) {\n" + cjs + "\n})")(
    (name) => {
      if (name === "react" || name.startsWith("react/")) return requireApp(name);
      assert(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
      return imports[name];
    },
    module,
    module.exports,
  );
  return module.exports.default;
}

const idsFile = "src/types/form/PersonalBankAccountForm.ts";
const inputIDs = evaluate(compile(sourceAtBase(idsFile), idsFile, false), {});
const fields = ["legalFirstName", "legalLastName"];
assert.deepEqual([inputIDs.BANK_INFO_STEP.FIRST_NAME, inputIDs.BANK_INFO_STEP.LAST_NAME], fields);

async function measure(code) {
  let input;
  let root;
  let previous;
  const hooks = [];
  const lifecycle = [];
  const submissions = [];
  const callbacks = [];
  const translations = [];
  const samples = [];
  const callbackIDs = new Map();
  const callback = (id) => {
    const fn = (...args) => callbacks.push({ id, args });
    callbackIDs.set(fn, id);
    return fn;
  };
  const nextA = callback("nextA");
  const nextB = callback("nextB");
  const moveA = callback("moveA");
  const moveB = callback("moveB");
  const translator = (locale) => (key) => {
    translations.push(`${locale}:${key}`);
    return `${locale}:${key}`;
  };
  const en = translator("en");
  const fr = translator("fr");
  const details = Object.freeze({ legalFirstName: "Ada", legalLastName: "Lovelace" });
  const initial = {
    details,
    onNext: nextA,
    onMove: moveA,
    isEditing: false,
    enabledWhenOffline: false,
    translate: en,
    locale: "en",
  };
  /** @type {Array<[string, Record<string, unknown>, [string, string]]>} */
  const changes = [
    ["mount", {}, ["Ada", "Lovelace"]],
    ["stable", {}, ["Ada", "Lovelace"]],
    ["unrelated", { noise: 1 }, ["Ada", "Lovelace"]],
    [
      "equalNames",
      { details: Object.freeze({ ...details, birthday: "1815-12-10" }) },
      ["Ada", "Lovelace"],
    ],
    [
      "firstName",
      { details: Object.freeze({ legalFirstName: "Grace", legalLastName: "Lovelace" }) },
      ["Grace", "Lovelace"],
    ],
    [
      "lastName",
      { details: Object.freeze({ legalFirstName: "Grace", legalLastName: "Hopper" }) },
      ["Grace", "Hopper"],
    ],
    ["missingFirst", { details: Object.freeze({ legalLastName: "Hopper" }) }, ["", "Hopper"]],
    ["missingLast", { details: Object.freeze({ legalFirstName: "Grace" }) }, ["Grace", ""]],
    ["missingDetails", { details: undefined }, ["", ""]],
    [
      "nullNames",
      { details: Object.freeze({ legalFirstName: null, legalLastName: null }) },
      ["", ""],
    ],
    ["emptyNames", { details: Object.freeze({ legalFirstName: "", legalLastName: "" }) }, ["", ""]],
    ["stableEmpty", {}, ["", ""]],
    ["nextCallback", { onNext: nextB }, ["", ""]],
    ["moveCallback", { onMove: moveB }, ["", ""]],
    ["editing", { isEditing: true }, ["", ""]],
    ["offline", { enabledWhenOffline: true }, ["", ""]],
    ["locale", { translate: fr, locale: "fr" }, ["", ""]],
    ["revisit", initial, ["Ada", "Lovelace"]],
  ];
  const imports = {
    "@components/SubStepForms/FullNameStep": "FullNameStep",
    "@src/ONYXKEYS": {
      PRIVATE_PERSONAL_DETAILS: "privatePersonalDetails",
      FORMS: { PERSONAL_BANK_ACCOUNT_FORM: "personalBankAccountForm" },
    },
    "@src/types/form/PersonalBankAccountForm": inputIDs,
    "@hooks/useLocalize": () => {
      hooks.push("useLocalize");
      return { translate: input.translate };
    },
    "@hooks/useOnyx": (key) => {
      hooks.push("useOnyx");
      assert.equal(key, "privatePersonalDetails");
      React.useEffect(() => {
        lifecycle.push(`subscribe:${key}`);
        return () => lifecycle.push(`unsubscribe:${key}`);
      }, [key]);
      return [input.details];
    },
    "@hooks/usePersonalBankAccountDetailsFormSubmit": ({ fieldIds, onNext, shouldSaveDraft }) => {
      hooks.push("useSubmit");
      assert.deepEqual(fieldIds, fields);
      const nextID = callbackIDs.get(onNext);
      React.useEffect(() => {
        lifecycle.push(`setup:${nextID}:${shouldSaveDraft}`);
        return () => lifecycle.push(`cleanup:${nextID}:${shouldSaveDraft}`);
      }, [fieldIds, onNext, shouldSaveDraft, nextID]);
      return React.useCallback(
        (formValues) => {
          submissions.push({ formValues, nextID, shouldSaveDraft });
          onNext();
        },
        [onNext, nextID, shouldSaveDraft],
      );
    },
  };
  const Component = evaluate(code, imports);
  assert.equal(Component.displayName, "LegalNameStep");
  input = initial;
  try {
    for (const [label, change, names] of changes) {
      input = { ...input, ...change };
      const start = hooks.length;
      // oxlint-disable-next-line no-await-in-loop -- Each update observes the preceding committed state.
      await act(() => {
        const element = React.createElement(Component, {
          onNext: input.onNext,
          onMove: input.onMove,
          isEditing: input.isEditing,
          enabledWhenOffline: input.enabledWhenOffline,
          noise: input.noise,
        });
        if (root) root.update(element);
        else root = create(element);
      });
      assert.deepEqual(hooks.slice(start), ["useLocalize", "useOnyx", "useSubmit"], label);
      const { props } = root.root.findByType("FullNameStep");
      const expected = { firstName: names[0], lastName: names[1] };
      assert.deepEqual(props.defaultValues, expected, label);
      assert.equal(props.formTitle, `${input.locale}:personalInfoStep.whatsYourLegalName`);
      assert.equal(props.formSubtitle, `${input.locale}:personalInfoStep.legalNameSubtitle`);
      assert.equal(props.formID, "personalBankAccountForm");
      assert.deepEqual(props.stepFields, fields);
      assert.equal(props.firstNameInputID, fields[0]);
      assert.equal(props.lastNameInputID, fields[1]);
      assert.equal(props.onNext, input.onNext);
      assert.equal(props.onMove, input.onMove);
      assert.equal(props.isEditing, input.isEditing);
      assert.equal(props.enabledWhenOffline, input.enabledWhenOffline);
      const formValues = Object.freeze({
        legalFirstName: `submitted:${label}`,
        legalLastName: "Input",
      });
      props.onSubmit(formValues);
      props.onNext("directNext");
      props.onMove("legalName");
      assert.deepEqual(submissions.at(-1), {
        formValues,
        nextID: callbackIDs.get(input.onNext),
        shouldSaveDraft: input.isEditing,
      });
      assert.equal(submissions.at(-1).formValues, formValues);
      assert.deepEqual(callbacks.slice(-3), [
        { id: callbackIDs.get(input.onNext), args: [] },
        { id: callbackIDs.get(input.onNext), args: ["directNext"] },
        { id: callbackIDs.get(input.onMove), args: ["legalName"] },
      ]);
      samples.push({ label, expected, reused: !!previous && previous === props.defaultValues });
      previous = props.defaultValues;
    }
  } finally {
    if (root) await act(() => root.unmount());
  }
  assert.deepEqual(lifecycle, [
    "subscribe:privatePersonalDetails",
    "setup:nextA:false",
    "cleanup:nextA:false",
    "setup:nextB:false",
    "cleanup:nextB:false",
    "setup:nextB:true",
    "cleanup:nextB:true",
    "setup:nextA:false",
    "unsubscribe:privatePersonalDetails",
    "cleanup:nextA:false",
  ]);
  return { samples, hooks, lifecycle, callbacks, submissions, translations };
}

const results = {};
for (const [mode, options] of Object.entries(modes)) {
  const code = compile(source, filename, options);
  results[mode] = {
    codeHash: hash(code),
    slots: Number(code.match(/const \$ = _c\((\d+)\)/)?.[1] ?? 0),
    guards: code.split("\n").filter((line) => line.trim().startsWith("if ($[")).length,
    // oxlint-disable-next-line no-await-in-loop -- React act scopes and controlled hook inputs are sequential.
    runtime: await measure(code),
  };
}
assert.deepEqual(
  [results.baseline.slots, results.scheduled.slots],
  [21, 19],
  "Pin this native optimization canary explicitly when upgrading",
);
assert.deepEqual([results.baseline.guards, results.scheduled.guards], [6, 5]);
assert.deepEqual(
  results.baseline.runtime,
  results.scheduled.runtime,
  "Same observations and cache reuse",
);
assert.deepEqual(results.source.runtime, results.motionBaseline.runtime);
assert.deepEqual(results.source.runtime, results.motionScheduled.runtime);
for (const result of Object.values(results)) {
  for (const key of ["hooks", "lifecycle", "callbacks", "submissions"]) {
    assert.deepEqual(result.runtime[key], results.source.runtime[key], key);
  }
}
assert.equal(results.motionBaseline.slots, 0);
assert.equal(results.motionScheduled.slots, 0);
const controlsBase = "b14f3591fad1db21c32271e79e9fe66b433fc5dc";
const compileOnlyControls = [];
/** @type {Array<[string, number[], boolean, boolean]>} */
const controls = [
  ["src/hooks/usePoliciesWithCardFeedErrors.ts", [], true, false],
  ["src/pages/RejectExpenseReportPage.tsx", [98], false, false],
  ["src/hooks/useWorkspaceAgentsTable.ts", [13], false, true],
];
for (const [file, expectedSlots, unchanged, guardOnlyChange] of controls) {
  const controlSource = execFileSync("git", ["show", `${controlsBase}:${file}`], {
    cwd: app,
    encoding: "utf8",
  });
  const codes = [modes.baseline, modes.scheduled].map((options) =>
    compile(controlSource, file, options),
  );
  const slots = codes.map((code) =>
    [...code.matchAll(/\b_c\((\d+)\)/g)].map((match) => Number(match[1])),
  );
  assert.deepEqual(slots, [expectedSlots, expectedSlots], `${file}: no claimed cache-slot gain`);
  assert.equal(codes[0] === codes[1], unchanged, `${file}: pinned emitted-code control`);
  if (guardOnlyChange) {
    const withoutGuards = codes.map((code) =>
      code.replace(/^(\s*)if \(\$\[.*$/gm, "$1<cache guard>"),
    );
    assert.equal(withoutGuards[0], withoutGuards[1], `${file}: only signed-zero guards differ`);
  }
  compileOnlyControls.push({
    file,
    base: controlsBase,
    sourceHash: hash(controlSource),
    codeHashes: codes.map(hash),
    slots,
    unchanged,
    guardOnlyChange,
  });
}
const report = {
  base,
  filename,
  sourceHash: hash(source),
  configHash: hash(configSource),
  binding,
  versions: {
    node: process.version,
    react: React.version,
    nativePackage: JSON.parse(
      readFileSync(path.join(path.dirname(binding), "package.json"), "utf8"),
    ).version,
  },
  config,
  results,
  compileOnlyControls,
  totalRenders: 90,
  totalSubmissions: 90,
  totalCallbackInvocations: 270,
  limits:
    "Pinned App source, real React rendering, controlled imported hooks and inert child. No real Onyx, form persistence, device UI or latency measurement. Cache counts are bookkeeping, not a speedup score.",
};
if (values.output) writeFileSync(values.output, JSON.stringify(report, null, 2) + "\n");
// oxlint-disable-next-line no-console -- The CLI emits its machine-readable result to stdout.
console.log(
  JSON.stringify(
    {
      ...report,
      results: Object.fromEntries(
        Object.entries(results).map(([mode, result]) => [
          mode,
          {
            codeHash: result.codeHash,
            slots: result.slots,
            guards: result.guards,
            renders: result.runtime.samples.length,
            reusedDefaults: result.runtime.samples.filter((sample) => sample.reused).length,
          },
        ]),
      ),
    },
    null,
    2,
  ),
);
