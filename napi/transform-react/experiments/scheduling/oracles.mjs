import { isDeepStrictEqual } from "node:util";
import { parse, Parser } from "acorn";
import jsx from "acorn-jsx";

export const parseSource = (code) =>
  Parser.extend(jsx()).parse(code, { ecmaVersion: "latest", sourceType: "module" });

// Source-only preflight admits exactly the observer JSX form, with no optimization.
export function lowerObserverJSX(code) {
  const pending = [parseSource(code)];
  const replacements = [];
  while (pending.length) {
    const node = pending.pop();
    if (node.type === "JSXElement") {
      const opening = node.openingElement;
      const attribute = opening.attributes[0];
      if (
        opening.name.name !== "CommitObserver" ||
        !opening.selfClosing ||
        opening.attributes.length !== 1 ||
        attribute.name.name !== "value" ||
        attribute.value.type !== "JSXExpressionContainer"
      ) {
        throw new Error("Source-only preflight accepts only <CommitObserver value={expression} />");
      }
      const expression = attribute.value.expression;
      replacements.push({
        start: node.start,
        end: node.end,
        text: `createElement(CommitObserver, {value: ${code.slice(expression.start, expression.end)}})`,
      });
      continue;
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) pending.push(...child.filter((entry) => entry?.type));
      else if (child?.type) pending.push(child);
    }
  }
  for (const replacement of replacements.sort((a, b) => b.start - a.start))
    code = code.slice(0, replacement.start) + replacement.text + code.slice(replacement.end);
  return code;
}

export function snapshot(
  value,
  { invoke = false, actions = [] } = {},
  key = "",
  ancestors = new Set(),
) {
  if (typeof value === "function") {
    return invoke && !actions.includes(key)
      ? snapshot(value(), { invoke, actions }, key, ancestors)
      : "<function>";
  }
  if (value === undefined) return { $type: "undefined" };
  if (typeof value === "number" && Object.is(value, -0)) return { $type: "negative-zero" };
  if (typeof value === "number" && !Number.isFinite(value)) return { $type: String(value) };
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) throw new Error("Cyclic output is outside the admitted fixture subset");
  ancestors.add(value);
  const result = Array.isArray(value)
    ? Array.from({ length: value.length }, (_, index) =>
        Object.hasOwn(value, index)
          ? snapshot(value[index], { invoke, actions }, String(index), ancestors)
          : { $type: "hole" },
      )
    : Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((name) => [name, snapshot(value[name], { invoke, actions }, name, ancestors)]),
      );
  ancestors.delete(value);
  return result;
}

export function equal(actual, expected) {
  return isDeepStrictEqual(snapshot(actual), snapshot(expected));
}

export function failure(check, actual, expected, step = null, kind = "semantic") {
  const normalizedActual = snapshot(actual);
  const normalizedExpected = snapshot(expected);
  return {
    kind,
    check,
    step,
    actual: normalizedActual,
    expected: normalizedExpected,
    differences: differences(normalizedActual, normalizedExpected),
  };
}

export function differences(actual, expected, path = "$") {
  if (isDeepStrictEqual(actual, expected)) return [];
  if (
    actual !== null &&
    expected !== null &&
    typeof actual === "object" &&
    typeof expected === "object" &&
    Array.isArray(actual) === Array.isArray(expected)
  ) {
    const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
    if (Array.isArray(actual) && actual.length !== expected.length) keys.add("length");
    return [...keys].flatMap((key) => differences(actual[key], expected[key], `${path}.${key}`));
  }
  return [{ path, actual: snapshot(actual), expected: snapshot(expected) }];
}

function atomicFailures(failures) {
  return failures.flatMap((issue) =>
    issue.differences?.length
      ? issue.differences.map((difference) => ({
          kind: issue.kind,
          check: issue.check,
          step: issue.step,
          ...difference,
        }))
      : [issue],
  );
}

export function check(failures, name, actual, expected, step = null, kind = "semantic") {
  if (!equal(actual, expected)) failures.push(failure(name, actual, expected, step, kind));
}

export function errorRecord(error) {
  return {
    name: error?.name ?? typeof error,
    message: error?.message ?? String(error),
    stack: error?.stack ?? null,
  };
}

export function analyzeCode(code) {
  const ast = parse(code, { ecmaVersion: "latest", sourceType: "module", locations: true });
  const cacheAliases = new Set();
  const functions = {};
  const operationOrder = {};
  const runtimeImports = [];
  for (const statement of ast.body) {
    if (statement.type !== "ImportDeclaration") continue;
    if (!["react/compiler-runtime", "react-compiler-runtime"].includes(statement.source.value))
      continue;
    runtimeImports.push(statement.source.value);
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportSpecifier" && specifier.imported.name === "c")
        cacheAliases.add(specifier.local.name);
    }
  }
  const pending = [{ node: ast, owner: "<module>", parent: null }];
  while (pending.length) {
    const { node, parent, owner } = pending.pop();
    let nextOwner = owner;
    if (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)
    ) {
      const localName =
        node.id?.name ??
        (parent?.type === "VariableDeclarator" ? parent.id.name : null) ??
        `<anonymous:${node.loc.start.line}:${node.loc.start.column}>`;
      nextOwner = owner === "<module>" ? localName : `${owner}.${localName}`;
      functions[nextOwner] = { cacheCalls: 0, slots: [], line: node.loc.start.line };
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      cacheAliases.has(node.callee.name)
    ) {
      functions[owner] ??= { cacheCalls: 0, slots: [], line: node.loc.start.line };
      functions[owner].cacheCalls++;
      functions[owner].slots.push(
        node.arguments[0]?.type === "Literal" ? node.arguments[0].value : "<dynamic>",
      );
    }
    let operation;
    if (
      node.type === "VariableDeclarator" &&
      ["ArrayExpression", "ObjectExpression"].includes(node.init?.type)
    )
      operation = `${node.id.name}:${node.init.type}`;
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      /^use[A-Z]/.test(node.callee.name)
    )
      operation = node.callee.name;
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.property.name === "push"
    )
      operation = `${node.callee.object.name}.push`;
    if (operation) {
      operationOrder[owner] ??= [];
      operationOrder[owner].push({ operation, start: node.start });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc") continue;
      if (Array.isArray(value)) {
        for (const child of value)
          if (child?.type) pending.push({ node: child, owner: nextOwner, parent: node });
      } else if (value?.type) pending.push({ node: value, owner: nextOwner, parent: node });
    }
  }
  return {
    functions,
    runtimeImports,
    operationOrder: Object.fromEntries(
      Object.entries(operationOrder).map(([owner, events]) => [
        owner,
        events.sort((a, b) => a.start - b.start).map(({ operation }) => operation),
      ]),
    ),
  };
}

export function normalizedDiagnostics(diagnostics) {
  return diagnostics
    .map(({ severity, message, labels, helpMessage }) => ({
      severity,
      message,
      labels: labels ?? [],
      helpMessage: helpMessage ?? null,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function dependencyEqual(previous, current, names) {
  return names.every((name) => Object.is(getPath(previous, name), getPath(current, name)));
}

export function getPath(value, path) {
  return path.split(".").reduce((parent, name) => parent?.[name], value);
}

export function identityObservations(current, previous, fields) {
  return Object.fromEntries(
    [...fields, "$result"].map((field) => [
      field,
      previous === undefined
        ? null
        : Object.is(
            field === "$result" ? current : current[field],
            field === "$result" ? previous : previous[field],
          ),
    ]),
  );
}

export function goalFailures(spec, samples) {
  if (!spec.goal) return [];
  const failures = [];
  for (let index = 1; index < samples.length; index++) {
    const current = samples[index];
    const previous = samples[index - 1];
    if (!current.committed || !previous.committed || current.reset) continue;
    const expected = Object.fromEntries(
      Object.entries(spec.goal.dependencies).map(([field, names]) => [
        field,
        names.every((name) => equal(getPath(previous.input, name), getPath(current.input, name))),
      ]),
    );
    if (spec.goal.result) expected.$result = Object.values(expected).every(Boolean);
    for (const [field, value] of Object.entries(expected)) {
      check(
        failures,
        `independent-reuse:${field}`,
        current.same[field],
        value,
        current.label,
        "optimization",
      );
    }
  }
  return failures;
}

export function assessVariants(variants, spec) {
  const source = variants.source;
  const disabled = variants.disabled;
  const enabled = variants.enabled;
  const findings = [];
  for (const issue of source?.failures ?? [])
    findings.push({ ...issue, classification: "source-or-oracle-failure" });
  if (!disabled || !enabled) return findings;
  const key = (issue) =>
    JSON.stringify([
      issue.kind,
      issue.check,
      issue.step,
      issue.path,
      issue.actual,
      issue.expected,
      issue.error?.name,
      issue.error?.message,
    ]);
  const location = (issue) => JSON.stringify([issue.kind, issue.check, issue.step, issue.path]);
  const disabledFailures = atomicFailures(disabled.failures);
  const enabledFailures = atomicFailures(enabled.failures);
  const disabledKeys = new Set(disabledFailures.map(key));
  const enabledKeys = new Set(enabledFailures.map(key));
  const enabledLocations = new Set(enabledFailures.map(location));
  for (const issue of disabledFailures) {
    const classification = enabledKeys.has(key(issue))
      ? "baseline-compiler-failure"
      : enabledLocations.has(location(issue))
        ? "baseline-overlap-with-enabled-difference"
        : "baseline-failure-not-reproduced-enabled";
    findings.push({ ...issue, classification });
  }
  for (const issue of enabledFailures) {
    if (!disabledKeys.has(key(issue)))
      findings.push({
        ...issue,
        classification: source?.failures.length
          ? "untrusted-enabled-difference"
          : "enabled-regression",
      });
  }
  const diagnosticChanges = [];
  check(
    diagnosticChanges,
    "diagnostic-coverage",
    normalizedDiagnostics(enabled.diagnostics),
    normalizedDiagnostics(disabled.diagnostics),
    null,
    "coverage",
  );
  for (const issue of diagnosticChanges)
    findings.push({ ...issue, classification: "enabled-diagnostic-change" });
  for (const [name, detail] of Object.entries(disabled.analysis?.functions ?? {})) {
    if (detail.cacheCalls && !enabled.analysis?.functions[name]?.cacheCalls) {
      findings.push({
        ...failure(
          `preserve-function-cache:${name}`,
          0,
          "at least one cache call",
          null,
          "coverage",
        ),
        classification: "enabled-cache-coverage-loss",
      });
    }
  }
  for (const sample of disabled.samples) {
    const scheduled = enabled.samples.find(({ label }) => label === sample.label);
    if (!sample.committed || !scheduled?.committed || sample.reset || scheduled.reset) continue;
    for (const [field, reused] of Object.entries(sample.same)) {
      if (reused === true && scheduled.same[field] === false) {
        findings.push({
          ...failure(
            `baseline-reuse-preserved:${field}`,
            false,
            true,
            sample.label,
            "optimization",
          ),
          classification: "optimization-regression",
        });
      }
    }
  }
  if (variants.noMemoDisabled && variants.noMemoEnabled) {
    const before = variants.noMemoDisabled;
    const after = variants.noMemoEnabled;
    const beforeFailures = atomicFailures(before.failures);
    const afterFailures = atomicFailures(after.failures);
    const beforeKeys = new Set(beforeFailures.map(key));
    const afterKeys = new Set(afterFailures.map(key));
    for (const issue of beforeFailures)
      findings.push({
        ...issue,
        classification: afterKeys.has(key(issue))
          ? "baseline-no-memo-failure"
          : "baseline-no-memo-failure-not-reproduced-enabled",
      });
    for (const issue of afterFailures)
      if (!beforeKeys.has(key(issue)))
        findings.push({ ...issue, classification: "scheduler-only-regression" });
    const changes = [];
    check(
      changes,
      "no-memo-diagnostic-coverage",
      normalizedDiagnostics(after.diagnostics),
      normalizedDiagnostics(before.diagnostics),
      null,
      "coverage",
    );
    for (const issue of changes)
      findings.push({ ...issue, classification: "scheduler-only-diagnostic-change" });
  }
  if (spec.goal) {
    for (const issue of goalFailures(spec, enabled.samples)) {
      findings.push({
        ...issue,
        classification: spec.goal.required
          ? "required-optimization-miss"
          : "optional-optimization-miss",
      });
    }
  }
  return findings;
}

export function assessCanary(result, requireNoMemo = false) {
  const { source, disabled, enabled } = result.variants;
  if (!source || !disabled || !enabled)
    return { passed: false, reason: "All three native-transform variants are required" };
  const clean = [source, disabled, enabled].every((variant) => variant.failures.length === 0);
  const outputDiffers = disabled.code !== enabled.code;
  const reuse = (variant) =>
    variant.samples.reduce(
      (total, sample) => total + ["a", "b"].filter((name) => sample.same?.[name] === true).length,
      0,
    );
  const disabledReuse = reuse(disabled);
  const enabledReuse = reuse(enabled);
  const compiled = (enabled.analysis?.functions.SchedulingProbe?.cacheCalls ?? 0) > 0;
  let noMemo = null;
  if (requireNoMemo) {
    const { noMemoDisabled: before, noMemoEnabled: after } = result.variants;
    const noCaches =
      before &&
      after &&
      [before, after].every(
        (variant) =>
          variant.failures.length === 0 &&
          Object.values(variant.analysis?.functions ?? {}).every(
            ({ cacheCalls }) => cacheCalls === 0,
          ),
      );
    const beforeOrder = before?.analysis?.operationOrder.SchedulingProbe;
    const afterOrder = after?.analysis?.operationOrder.SchedulingProbe;
    const concreteMovement = Boolean(
      beforeOrder?.length && afterOrder?.length && !equal(beforeOrder, afterOrder),
    );
    noMemo = {
      passed: Boolean(noCaches && concreteMovement && after.code !== enabled.code),
      noCaches: Boolean(noCaches),
      concreteMovement,
      beforeOrder,
      afterOrder,
    };
  }
  const passed =
    clean &&
    compiled &&
    outputDiffers &&
    enabledReuse > disabledReuse &&
    (!requireNoMemo || noMemo.passed);
  return {
    passed,
    clean,
    compiled,
    outputDiffers,
    disabledReuse,
    enabledReuse,
    noMemo,
    reason: passed
      ? "The option changes emitted code and increases real-React independent field reuse"
      : "Inactive, ignored, unsupported, or regressing scheduler option; this run is not scheduler evidence",
  };
}
