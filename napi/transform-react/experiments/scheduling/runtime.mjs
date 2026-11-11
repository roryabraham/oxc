import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SourceTextModule, SyntheticModule } from "node:vm";
import React from "react";
import TestRenderer from "react-test-renderer";
import {
  accessEventSequence,
  analyzeCode,
  assessVariants,
  check,
  dependencyEqual,
  errorRecord,
  failure,
  getPath,
  identityObservations,
  lowerObserverJSX,
  sampleSemanticallyClean,
  snapshot,
} from "./oracles.mjs";
import { buildCase } from "./generate.mjs";

const require = createRequire(import.meta.url);
const realRuntime = require("react/compiler-runtime");
const { act, create } = TestRenderer;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export function compilerOptions(variant) {
  return {
    lang: "jsx",
    reactCompiler:
      variant === "source"
        ? false
        : {
            target: "19",
            compilationMode: "infer",
            panicThreshold: "none",
            reportDiagnostics: true,
            environment: {
              enableInstructionReordering: ["enabled", "noMemoEnabled"].includes(variant),
              ...(variant.startsWith("noMemo") ? { disableMemoizationForTesting: true } : {}),
            },
          },
  };
}

export async function loadBinding(bindingPath) {
  const binding = bindingPath.endsWith(".node")
    ? require(bindingPath)
    : await import(pathToFileURL(bindingPath).href);
  if (typeof binding.transformSync !== "function")
    throw new Error(`No transformSync export at ${bindingPath}`);
  if (binding.__napiBindingTarget && binding.__napiBindingTarget !== "native") {
    throw new Error(`Expected a native binding, received ${binding.__napiBindingTarget}`);
  }
  const artifacts = [
    ...new Set([
      bindingPath,
      ...Object.keys(require.cache).filter((name) => name.endsWith(".node")),
    ]),
  ];
  const buildMetadata = path.join(path.dirname(bindingPath), "build-metadata.json");
  return {
    binding,
    metadata: {
      target:
        binding.__napiBindingTarget ?? (bindingPath.endsWith(".node") ? "native" : "not-reported"),
      build: existsSync(buildMetadata) ? JSON.parse(readFileSync(buildMetadata, "utf8")) : null,
      artifacts: artifacts.map((file) => ({
        path: realpathSync(file),
        sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
      })),
    },
  };
}

export function versions() {
  return Object.fromEntries(
    ["react", "react-test-renderer", "acorn", "acorn-jsx"].map((name) => [
      name,
      require(`${name}/package.json`).version,
    ]),
  );
}

function moduleFromExports(exports, identifier) {
  return new SyntheticModule(
    Object.keys(exports),
    function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    },
    { identifier },
  );
}

async function evaluate(code, modules, identifier) {
  const compiled = new SourceTextModule(code, { identifier });
  const linked = new Map();
  await compiled.link((name) => {
    if (!Object.hasOwn(modules, name))
      throw new Error(`Offline module allowlist rejected import: ${name}`);
    if (!linked.has(name))
      linked.set(name, moduleFromExports(modules[name], `${identifier}/${name}`));
    return linked.get(name);
  });
  await compiled.evaluate({ timeout: 5000 });
  if (typeof compiled.namespace.default !== "function")
    throw new Error("Fixture must export a default hook function");
  return compiled.namespace.default;
}

function makeOperations(state) {
  const count = (name) => {
    state.calls[name] = (state.calls[name] ?? 0) + 1;
  };
  return {
    observe(event) {
      state.events.push({ step: state.step, event });
    },
    buildA(items) {
      count("buildA");
      return items.slice();
    },
    buildB(items) {
      count("buildB");
      return items.slice();
    },
    cheap(items) {
      count("cheap");
      return items.length > 0;
    },
    expensive(items) {
      count("expensive");
      return typeof items === "boolean"
        ? items
          ? "positive"
          : "empty"
        : items.reduce((sum, item) => sum + item, 0);
    },
    snapshot(items) {
      count("snapshot");
      return items.slice();
    },
    mutate(items, value) {
      count("mutate");
      items.push(value);
    },
    capture(items) {
      count("capture");
      return () => items.slice();
    },
    mayThrow(value) {
      count("mayThrow");
      if (value < 0) throw new Error(`negative:${value}`);
      return value;
    },
  };
}

function observedReact(state) {
  const wrapped = { ...React };
  for (const name of [
    "useEffect",
    "useLayoutEffect",
    "useState",
    "useRef",
    "useMemo",
    "useCallback",
    "use",
  ]) {
    wrapped[name] = (...args) => {
      const record = { name };
      if (["useState", "useRef"].includes(name)) record.argument = snapshot(args[0]);
      state.attempt?.hooks.push(record);
      return React[name](...args);
    };
  }
  return { ...wrapped, default: wrapped };
}

function observedRuntime(state) {
  return {
    ...realRuntime,
    c(size) {
      const cache = realRuntime.c(size);
      const access = { slots: size, reads: 0, writes: 0 };
      state.attempt?.caches.push(access);
      return new Proxy(cache, {
        get(target, key) {
          if (typeof key === "string" && /^\d+$/.test(key)) access.reads++;
          return Reflect.get(target, key);
        },
        set(target, key, value) {
          if (typeof key === "string" && /^\d+$/.test(key)) access.writes++;
          return Reflect.set(target, key, value);
        },
      });
    },
  };
}

function makeInputs(spec, state) {
  const arrays = new Map();
  const resources = new Map();
  const getResource = (name) => {
    if (!resources.has(name)) {
      let resolve;
      const promise = new Promise((done) => {
        resolve = done;
      });
      resources.set(name, { promise, resolve });
    }
    return resources.get(name);
  };
  return {
    prepare(input) {
      const result = { ...input };
      for (const name of ["inputA", "inputB", "inputC"]) {
        if (!Array.isArray(input[name])) continue;
        const key = `${name}:${JSON.stringify(input[name])}`;
        if (spec.internArrays && arrays.has(key)) result[name] = arrays.get(key);
        else {
          result[name] = Object.freeze([...input[name]]);
          if (spec.internArrays) arrays.set(key, result[name]);
        }
      }
      if (spec.external === "getter") {
        result.data = Object.freeze({
          get left() {
            if (state.attempt) state.externalEvents.push("get:left");
            return input.inputA;
          },
          get right() {
            if (state.attempt) state.externalEvents.push("get:right");
            return input.inputB;
          },
        });
      } else if (spec.external === "proxy") {
        result.data = new Proxy(Object.freeze({ left: input.inputA, right: input.inputB }), {
          get(target, key) {
            if (state.attempt) state.externalEvents.push(`get:${String(key)}`);
            return Reflect.get(target, key);
          },
        });
      } else if (spec.external === "coercion") {
        result.data = Object.fromEntries(
          ["left", "right"].map((side) => [
            side,
            {
              [Symbol.toPrimitive]() {
                if (state.attempt) state.externalEvents.push(`key:${side}`);
                return "value";
              },
            },
          ]),
        );
      } else if (spec.external === "iterator") {
        result.data = Object.fromEntries(
          ["left", "right"].map((side) => [
            side,
            {
              *[Symbol.iterator]() {
                if (state.attempt) state.externalEvents.push(`iterate:${side}`);
                yield side === "left" ? input.inputA : input.inputB;
              },
            },
          ]),
        );
      } else if (["anchor-getters", "anchor-calls"].includes(spec.external)) {
        for (const side of ["left", "right"]) {
          const read = () => {
            if (state.attempt) {
              const event = `${spec.external === "anchor-calls" ? "call" : "get"}:${side}`;
              state.externalEvents.push(event);
              state.attempt.externalEvents.push(event);
            }
            if (side === "left" ? input.throwLeft : input.throwRight)
              throw new Error(`${side}-error`);
            return side === "left" ? input.inputA : input.inputB;
          };
          result[side] =
            spec.external === "anchor-calls"
              ? read
              : Object.defineProperty({}, "value", { get: read });
        }
      }
      if (spec.suspense) {
        result.resource = getResource(input.resource).promise;
        if (Object.hasOwn(input, "resolve")) getResource(input.resource).resolve(input.resolve);
        if (input.resolveOther) getResource(input.resolveOther).resolve(99);
      }
      return result;
    },
  };
}

class ErrorBoundary extends React.Component {
  state = { error: null, resetKey: this.props.resetKey };
  static getDerivedStateFromError(error) {
    return { error };
  }
  static getDerivedStateFromProps(props, state) {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }
  componentDidCatch(error) {
    this.props.onError(error);
  }
  render() {
    return this.state.error
      ? React.createElement("error", null, this.state.error.message)
      : this.props.children;
  }
}

function effectEvent(effect, input, action) {
  return `${action}${effect.name ? `:${effect.name}` : ""}${effect.value ? `:${effect.value(input)}` : ""}`;
}

function effectsModel(spec) {
  let active = [];
  const events = [];
  const cleanup = () => {
    events.push(...active.map(({ effect, input }) => effectEvent(effect, input, "cleanup")));
    active = [];
  };
  return {
    cleanup,
    commit(current, input) {
      const effects = spec.effects ?? [];
      const next = effects.map((effect) => ({
        effect,
        input,
        dependency: effect.dependency === "mount" ? "mount" : current[effect.dependency],
      }));
      const changed = next.map(
        (entry, index) => !active[index] || !Object.is(entry.dependency, active[index].dependency),
      );
      events.push(
        ...active
          .filter((_, index) => changed[index])
          .map(({ effect, input: prior }) => effectEvent(effect, prior, "cleanup")),
      );
      events.push(
        ...next
          .filter((_, index) => changed[index])
          .map(({ effect }) => effectEvent(effect, input, "setup")),
      );
      active = next;
    },
    get events() {
      return events;
    },
  };
}

function verifyStrictResources(result, spec, events, currentInput, step, unmounted = false) {
  const active = new Map();
  for (const entry of events) {
    const input = spec.updates.find(({ label }) => label === entry.step);
    const effect = spec.effects.find(
      (effect) =>
        entry.event.startsWith(`setup:${effect.name}:`) ||
        entry.event.startsWith(`cleanup:${effect.name}:`),
    );
    if (!effect) {
      result.failures.push(failure("known-effect-event", entry, "a declared effect", step));
      continue;
    }
    if (entry.event.startsWith("setup:")) {
      check(
        result.failures,
        "resource-not-already-active",
        active.has(effect.name),
        false,
        entry.step,
      );
      check(
        result.failures,
        "setup-captures-committed-input",
        entry.event,
        effectEvent(effect, input, "setup"),
        entry.step,
      );
      active.set(effect.name, entry.event.replace("setup:", "cleanup:"));
    } else {
      check(
        result.failures,
        "cleanup-captures-own-resource",
        entry.event,
        active.get(effect.name),
        entry.step,
      );
      active.delete(effect.name);
    }
  }
  const expected = unmounted
    ? []
    : spec.effects.map((effect) => [effect.name, effectEvent(effect, currentInput, "cleanup")]);
  check(result.failures, "active-resource-after-commit", [...active], expected, step);
}

function verifyHooks(result, spec, variant, attempts, step) {
  const optional = variant === "source" ? [] : (spec.optionalCompiledHooks ?? []);
  const expected = spec.hooks.filter((name) => !optional.includes(name));
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    const observed = attempt.hooks
      .map(({ name }) => name)
      .filter((name) => !optional.includes(name));
    const expectedSequence = attempt.completed ? expected : expected.slice(0, observed.length);
    check(result.failures, `hooks:attempt-${index}`, observed, expectedSequence, step);
    for (const requirement of spec.hookArguments ?? []) {
      for (const hook of attempt.hooks.filter(({ name }) => name === requirement.name)) {
        check(
          result.failures,
          `hook-argument:${requirement.name}`,
          hook.argument,
          requirement.value,
          step,
        );
      }
    }
    if (spec.hookSiteArguments) {
      check(
        result.failures,
        "distinct-state-hook-sites",
        attempt.hooks.filter(({ name }) => name === "useState").map(({ argument }) => argument),
        spec.hookSiteArguments,
        step,
      );
    }
  }
}

function verifyCompilation(result, spec, variant) {
  const enabled = variant !== "source";
  check(result.failures, "fatal-transform", result.fatal, false, null, "compile");
  if (!enabled)
    check(result.failures, "source-diagnostics", result.diagnostics, [], null, "compile");
  if (enabled && spec.diagnostic?.required) {
    check(
      result.failures,
      "required-diagnostic",
      result.diagnostics.length > 0,
      true,
      null,
      "coverage",
    );
    check(
      result.failures,
      "diagnostic-category",
      result.diagnostics.some(({ message }) =>
        new RegExp(spec.diagnostic.pattern, "i").test(message),
      ),
      true,
      null,
      "coverage",
    );
  } else if (enabled && spec.goal?.required) {
    check(result.failures, "eligible-diagnostics", result.diagnostics, [], null, "coverage");
  }
  for (const [name, expectation] of Object.entries(spec.cache ?? {})) {
    const calls = result.analysis?.functions[name]?.cacheCalls ?? 0;
    if (!enabled || variant.startsWith("noMemo") || expectation === "forbidden")
      check(result.failures, `cache-forbidden:${name}`, calls, 0, null, "coverage");
    else if (
      expectation === "required" ||
      (expectation === "enabled-required" && variant === "enabled")
    )
      check(result.failures, `cache-required:${name}`, calls > 0, true, null, "coverage");
  }
  if (variant.startsWith("noMemo")) {
    check(
      result.failures,
      "no-memo-cache-count",
      Object.values(result.analysis?.functions ?? {}).reduce(
        (sum, { cacheCalls }) => sum + cacheCalls,
        0,
      ),
      0,
      null,
      "coverage",
    );
  }
  if (enabled && result.analysis?.runtimeImports.includes("react-compiler-runtime")) {
    result.failures.push(
      failure(
        "target19-runtime",
        "react-compiler-runtime",
        "react/compiler-runtime",
        null,
        "coverage",
      ),
    );
  }
}

function verifyPriorCounters(result) {
  if (result.variant !== "disabled" && result.variant !== "source") return;
  const expectedA =
    result.variant === "source" ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [1, 1, 2, 2, 2, 2, 3, 3, 3];
  const expectedB =
    result.variant === "source" ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [1, 1, 1, 1, 2, 2, 3, 3, 4];
  check(
    result.failures,
    "prior-grouped-buildA",
    result.samples.map((sample) => sample.calls.buildA),
    expectedA,
    null,
    "coverage",
  );
  check(
    result.failures,
    "prior-grouped-buildB",
    result.samples.map((sample) => sample.calls.buildB),
    expectedB,
    null,
    "coverage",
  );
}

export async function runVariant(task, spec, variant, binding, progress) {
  const options = compilerOptions(variant);
  options.lang = spec.lang ?? "jsx";
  if (options.reactCompiler && spec.compilationMode)
    options.reactCompiler.compilationMode = spec.compilationMode;
  const result = {
    variant,
    options: binding ? options : null,
    code: null,
    diagnostics: [],
    fatal: false,
    failures: [],
    samples: [],
    events: [],
    warnings: [],
    counts: {
      transforms: 0,
      renderRequests: 0,
      renderAttempts: 0,
      diagnosticStackProbes: 0,
      completedRenderAttempts: 0,
      committedSteps: 0,
      reactCommits: 0,
      mounts: 0,
      unmounts: 0,
      suspenseFallbacks: 0,
      caughtErrors: 0,
    },
  };
  progress({ variant, phase: "transform" });
  try {
    if (binding) {
      result.counts.transforms++;
      const transformed = binding.transformSync(
        `scheduling-probe.${options.lang}`,
        spec.source,
        options,
      );
      result.code = transformed.code;
      result.fatal = transformed.fatal;
      result.diagnostics = transformed.errors ?? [];
    } else result.code = lowerObserverJSX(spec.sourceWithoutTypes ?? spec.source);
    result.analysis = analyzeCode(result.code);
    verifyCompilation(result, spec, variant);
    progress({
      variant,
      phase: "compiled",
      code: result.code,
      diagnostics: result.diagnostics,
      analysis: result.analysis,
      counts: { ...result.counts },
    });
  } catch (error) {
    result.failures.push({
      kind: "compile",
      check: "transform-or-analysis",
      step: null,
      error: errorRecord(error),
    });
    return result;
  }
  if (result.fatal || spec.compileOnly) return result;

  const state = {
    step: null,
    attempt: null,
    events: [],
    calls: {},
    externalEvents: [],
    caught: [],
  };
  const expectedEffects = effectsModel(spec);
  const inputs = makeInputs(spec, state);
  const savedConsoleError = console.error;
  console.error = (...args) => {
    const message = args
      .map((value) => (typeof value === "string" ? value : String(value)))
      .join(" ");
    const knownRendererDeprecation = message.startsWith("react-test-renderer is deprecated.");
    const knownVmWarning = message.includes(
      "ExperimentalWarning: VM Modules is an experimental feature",
    );
    const expectedBoundaryWarning = Boolean(
      spec.errorBoundary &&
      message.includes("The above error occurred") &&
      spec.updates.some(({ error }) => error && message.includes(error)),
    );
    const existing = result.warnings.find((entry) => entry.message === message);
    if (existing) existing.count++;
    else
      result.warnings.push({
        message,
        count: 1,
        knownRendererDeprecation,
        knownVmWarning,
        expectedBoundaryWarning,
      });
  };
  let root;
  let committedValue;
  let observerCommits = 0;
  let previous;
  let previousInput;
  let attempts = [];
  let resetKey = 0;
  const retained = [];
  function CommitObserver({ value }) {
    React.useLayoutEffect(() => {
      committedValue = value;
      observerCommits++;
    });
    return React.createElement("output", null, JSON.stringify(snapshot(value)));
  }
  try {
    progress({ variant, phase: "module-evaluation" });
    const exported = await evaluate(
      result.code,
      {
        react: observedReact(state),
        "react/jsx-runtime": require("react/jsx-runtime"),
        "react/compiler-runtime": observedRuntime(state),
        "./operations": makeOperations(state),
        "./observer": { CommitObserver },
      },
      `${task.id}/${variant}.mjs`,
    );
    // React invokes this element type. The apply trap observes attempts, never values or commits.
    const component = spec.component
      ? exported
      : function GeneratedHookComponent(props) {
          const value = exported(props);
          return React.createElement(CommitObserver, { value });
        };
    const GeneratedComponent = new Proxy(component, {
      apply(target, receiver, args) {
        // React's development stack-frame probes invoke functions without props.
        // Every actual element in this harness supplies a props object.
        if (args[0] === undefined) {
          result.counts.diagnosticStackProbes++;
          return Reflect.apply(target, receiver, args);
        }
        const attempt = { hooks: [], caches: [], externalEvents: [], completed: false };
        attempts.push(attempt);
        state.attempt = attempt;
        result.counts.renderAttempts++;
        try {
          const element = Reflect.apply(target, receiver, args);
          attempt.completed = true;
          result.counts.completedRenderAttempts++;
          return element;
        } finally {
          state.attempt = null;
        }
      },
    });
    const makeElement = (props) => {
      let element = React.createElement(GeneratedComponent, props);
      if (spec.suspense)
        element = React.createElement(
          React.Suspense,
          { fallback: React.createElement("pending", null, "pending") },
          element,
        );
      if (spec.errorBoundary)
        element = React.createElement(
          ErrorBoundary,
          { resetKey, onError: (error) => state.caught.push(error.message) },
          element,
        );
      element = React.createElement(
        React.Profiler,
        {
          id: "scheduling-probe",
          onRender: () => {
            result.counts.reactCommits++;
          },
        },
        element,
      );
      if (spec.strict) element = React.createElement(React.StrictMode, null, element);
      return element;
    };
    for (let index = 0; index < spec.updates.length; index++) {
      const input = spec.updates[index];
      state.step = input.label;
      progress({ variant, phase: "render", step: input.label, index });
      attempts = [];
      state.externalEvents = [];
      const beforeObserverCommits = observerCommits;
      if (input.remount && root) {
        await act(() => root.unmount());
        root = null;
        result.counts.unmounts++;
        expectedEffects.cleanup();
        previous = undefined;
        previousInput = undefined;
      }
      if (input.reset) resetKey++;
      const props = { ...inputs.prepare(input), tick: index };
      const beforeCalls = { ...state.calls };
      const beforeEvents = state.events.length;
      state.caught = [];
      result.counts.renderRequests++;
      if (input.action) {
        const handler = input.actionFrom
          ? retained.find(({ label }) => label === input.actionFrom)?.value[input.action]
          : previous?.[input.action];
        if (typeof handler !== "function") throw new Error(`Missing action ${input.action}`);
        await act(() => handler());
      } else {
        await act(async () => {
          const element = makeElement(props);
          if (root) root.update(element);
          else {
            root = create(element, { unstable_strictMode: Boolean(spec.strict) });
            result.counts.mounts++;
          }
        });
      }
      const rendered = root.toJSON();
      const current = spec.scalarComponent ? { value: rendered } : committedValue;
      verifyHooks(result, spec, variant, attempts, input.label);
      check(result.failures, "render-attempt-present", attempts.length > 0, true, input.label);
      if (input.error) {
        result.counts.caughtErrors += state.caught.length;
        check(
          result.failures,
          "thrown-error-ui",
          rendered,
          { type: "error", props: {}, children: [input.error] },
          input.label,
        );
        check(
          result.failures,
          "caught-error",
          state.caught.includes(input.error),
          true,
          input.label,
        );
        expectedEffects.cleanup();
        previous = undefined;
        previousInput = undefined;
      } else if (input.suspended) {
        result.counts.suspenseFallbacks++;
        check(
          result.failures,
          "suspense-fallback",
          rendered,
          { type: "pending", props: {}, children: ["pending"] },
          input.label,
        );
        check(
          result.failures,
          "aborted-render-does-not-commit-effects",
          state.events.length,
          beforeEvents,
          input.label,
        );
        check(
          result.failures,
          "aborted-render-does-not-publish-values",
          observerCommits,
          beforeObserverCommits,
          input.label,
        );
      } else {
        check(
          result.failures,
          "completed-render-present",
          attempts.some((attempt) => attempt.completed),
          true,
          input.label,
        );
        const expected = spec.expected(input, false);
        const expectedRaw = spec.expected(input, true);
        check(
          result.failures,
          "returned-values",
          snapshot(current, { invoke: true, actions: spec.actionFields }),
          expected,
          input.label,
        );
        check(
          result.failures,
          "rendered-host-tree",
          rendered,
          spec.scalarComponent
            ? expectedRaw.value
            : { type: "output", props: {}, children: [JSON.stringify(snapshot(expectedRaw))] },
          input.label,
        );
        for (const [left, right] of spec.aliases ?? [])
          check(
            result.failures,
            `alias:${left}:${right}`,
            getPath(current, left) === getPath(current, right),
            true,
            input.label,
          );
        for (let left = 0; left < spec.distinct.length; left++) {
          for (let right = left + 1; right < spec.distinct.length; right++) {
            check(
              result.failures,
              `distinct:${spec.distinct[left]}:${spec.distinct[right]}`,
              current[spec.distinct[left]] === current[spec.distinct[right]],
              false,
              input.label,
            );
          }
        }
        if (spec.retain) {
          for (const retainedValue of retained) {
            check(
              result.failures,
              `retained-output:${retainedValue.label}`,
              snapshot(retainedValue.value, { invoke: true, actions: spec.actionFields }),
              retainedValue.expected,
              input.label,
            );
          }
          retained.push({ value: current, expected, label: input.label });
        }
        if (spec.manualIdentity && previous) {
          for (const [field, dependencies] of Object.entries(spec.manualIdentity)) {
            check(
              result.failures,
              `manual-memo-identity:${field}`,
              Object.is(current[field], previous[field]),
              dependencyEqual(previousInput, props, dependencies),
              input.label,
            );
          }
        }
        expectedEffects.commit(current, input);
        result.counts.committedSteps++;
      }
      if (spec.expectedEvents) {
        if (spec.eventsPerAttempt) {
          for (let attempt = 0; attempt < attempts.length; attempt++)
            check(
              result.failures,
              `execution-events:attempt-${attempt}`,
              accessEventSequence(
                attempts[attempt].externalEvents,
                variant,
                spec.accessEventPolicy,
              ),
              spec.expectedEvents,
              input.label,
            );
        } else
          check(
            result.failures,
            "accessor-events",
            accessEventSequence(state.externalEvents, variant, spec.accessEventPolicy),
            spec.expectedEvents,
            input.label,
          );
      }
      if (spec.strict) verifyStrictResources(result, spec, state.events, input, input.label);
      else
        check(
          result.failures,
          "effect-lifecycle",
          state.events.map(({ event }) => event),
          expectedEffects.events,
          input.label,
        );
      const committed = !input.error && !input.suspended;
      result.samples.push({
        label: input.label,
        input: snapshot(input),
        committed,
        reset: Boolean(input.remount || input.reset),
        same:
          committed && !spec.scalarComponent
            ? identityObservations(current, previous, spec.fields)
            : {},
        value: committed ? snapshot(current, { invoke: true, actions: spec.actionFields }) : null,
        attempts,
        calls: { ...state.calls },
        callDeltas: Object.fromEntries(
          Object.entries(state.calls).map(([name, total]) => [
            name,
            total - (beforeCalls[name] ?? 0),
          ]),
        ),
        externalEvents: [...state.externalEvents],
        externalEventCounts: Object.fromEntries(
          [...new Set(state.externalEvents)].map((event) => [
            event,
            state.externalEvents.filter((entry) => entry === event).length,
          ]),
        ),
        events: state.events.slice(beforeEvents),
      });
      if (committed) {
        previous = current;
        previousInput = props;
      }
      progress({
        variant,
        phase: "step-complete",
        step: input.label,
        counts: { ...result.counts },
      });
    }
    if (spec.priorCounters) verifyPriorCounters(result);
  } catch (error) {
    result.failures.push({
      kind: "runtime",
      check: "uncaught-harness-or-render-error",
      step: state.step,
      error: errorRecord(error),
    });
  } finally {
    progress({ variant, phase: "unmount" });
    state.step = "unmount";
    if (root) {
      try {
        await act(() => root.unmount());
        result.counts.unmounts++;
        expectedEffects.cleanup();
        if (spec.strict)
          verifyStrictResources(result, spec, state.events, spec.updates.at(-1), "unmount", true);
        else
          check(
            result.failures,
            "unmount-cleanup",
            state.events.map(({ event }) => event),
            expectedEffects.events,
            "unmount",
          );
      } catch (error) {
        result.failures.push({
          kind: "runtime",
          check: "unmount",
          step: "unmount",
          error: errorRecord(error),
        });
      }
    }
    console.error = savedConsoleError;
  }
  result.events = state.events;
  const unexpectedWarnings = result.warnings.filter(
    ({ knownRendererDeprecation, knownVmWarning, expectedBoundaryWarning }) =>
      !knownRendererDeprecation && !knownVmWarning && !expectedBoundaryWarning,
  );
  check(result.failures, "react-warnings", unexpectedWarnings, [], null, "runtime");
  for (const sample of result.samples) {
    sample.semanticallyClean = sampleSemanticallyClean(sample, result.failures);
  }
  return result;
}

export async function runTask(task, binding, progress = () => {}, noMemo = false) {
  const spec = buildCase(task);
  const variants = {};
  const names = binding
    ? ["source", "disabled", "enabled", ...(noMemo ? ["noMemoDisabled", "noMemoEnabled"] : [])]
    : ["source"];
  for (const variant of names) {
    variants[variant] = await runVariant(task, spec, variant, binding, progress);
    progress({ variant, phase: "variant-complete", result: variants[variant] });
  }
  return {
    task,
    source: spec.source,
    assumption: spec.assumption ?? null,
    optimizationGoal: spec.goal ?? null,
    cacheExpectations: spec.cache ?? {},
    accessEventPolicy: spec.accessEventPolicy ?? "exact",
    expectedBaselineDefects: spec.expectedBaselineDefects ?? [],
    observationKind: spec.scalarComponent ? "committed-host-text" : "layout-effect-value",
    variants,
    findings: assessVariants(variants, spec, task.id),
  };
}
