import { Parser } from "acorn";
import jsx from "acorn-jsx";

const parser = Parser.extend(jsx());

function componentTree(code) {
  const program = parser.parse(code, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true,
  });
  const component = program.body.find(
    (node) => node.type === "ExportNamedDeclaration" && node.declaration?.id?.name === "Component",
  )?.declaration;
  if (component?.type !== "FunctionDeclaration") {
    throw new Error("Expected an exported Component declaration");
  }
  const reactImports = new Map();
  for (const node of program.body) {
    if (node.type !== "ImportDeclaration" || node.source.value !== "react") continue;
    for (const specifier of node.specifiers) {
      if (specifier.type === "ImportSpecifier") {
        reactImports.set(specifier.imported.name, specifier.local.name);
      }
    }
  }
  const nodes = [];
  function visit(node, parents = []) {
    if (!node || typeof node.type !== "string") return;
    if (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)
    ) {
      return;
    }
    nodes.push({ node, parents });
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) visit(child, [...parents, node]);
      } else if (value && typeof value === "object") {
        visit(value, [...parents, node]);
      }
    }
  }
  visit(component.body);
  return { component, nodes, reactImports };
}

function hookCalls(tree, name) {
  const local = tree.reactImports.get(name);
  return tree.nodes.filter(
    ({ node }) =>
      node.type === "CallExpression"
      && node.callee.type === "Identifier"
      && node.callee.name === local,
  );
}

function callsite(tree, entry, code) {
  const declarator = entry.parents.findLast((node) => node.type === "VariableDeclarator");
  const declaration = entry.parents.findLast((node) => node.type === "VariableDeclaration");
  return {
    offset: entry.node.start,
    line: entry.node.loc.start.line,
    code: code.slice(declarator?.start ?? entry.node.start, declarator?.end ?? entry.node.end),
    unconditionalTopLevel:
      tree.component.body.body.includes(declaration) && declarator?.init === entry.node,
    bindings:
      declarator?.id.type === "ArrayPattern"
        ? declarator.id.elements.map((node) => node?.name)
        : [],
    initializer: entry.node.arguments[0]?.type === "Literal" ? entry.node.arguments[0].value : null,
  };
}

export function stateHookEvidence(code) {
  const tree = componentTree(code);
  const calls = hookCalls(tree, "useState").map((entry) => callsite(tree, entry, code));
  const identities = calls.map(({ initializer, bindings, unconditionalTopLevel }) => ({
    initializer,
    bindings,
    unconditionalTopLevel,
  }));
  const expected = [
    { initializer: 2, bindings: ["left", "setLeft"], unconditionalTopLevel: true },
    { initializer: 30, bindings: ["right", "setRight"], unconditionalTopLevel: true },
  ];
  return { passed: JSON.stringify(identities) === JSON.stringify(expected), calls, expected };
}

export function suspensionMotionEvidence(code) {
  const tree = componentTree(code);
  const arrays = tree.nodes.filter(
    ({ node }) => node.type === "ArrayExpression" && node.elements.length === 0,
  );
  const uses = hookCalls(tree, "use").filter(({ node }) => {
    const [argument] = node.arguments;
    return (
      argument?.type === "MemberExpression"
      && !argument.computed
      && argument.object.name === "resource"
      && argument.property.name === "promise"
    );
  });
  const states = hookCalls(tree, "useState");
  const pushes = tree.nodes.filter(
    ({ node }) =>
      node.type === "CallExpression"
      && node.callee.type === "MemberExpression"
      && !node.callee.computed
      && node.callee.object.name === "rows"
      && node.callee.property.name === "push"
      && node.arguments.length === 1
      && node.arguments[0].name === "payload",
  );
  if (arrays.length !== 1 || uses.length !== 1 || states.length !== 1 || pushes.length !== 1) {
    return {
      passed: false,
      reason:
        "Expected one rows allocation, use(resource.promise), useState, and rows.push(payload)",
      counts: {
        arrays: arrays.length,
        uses: uses.length,
        states: states.length,
        pushes: pushes.length,
      },
    };
  }
  const array = arrays[0];
  const parent = array.parents.at(-1);
  const target =
    parent.type === "VariableDeclarator"
      ? parent.id.name
      : parent.type === "AssignmentExpression"
        ? parent.left.name
        : null;
  const events = [
    { kind: "allocate-rows", node: array.node },
    { kind: "useState(3)", node: states[0].node },
    { kind: "use(resource.promise)", node: uses[0].node },
    { kind: "rows.push(payload)", node: pushes[0].node },
  ]
    .sort((left, right) => left.node.start - right.node.start)
    .map(({ kind, node }) => ({
      kind,
      offset: node.start,
      line: node.loc.start.line,
      code: code.slice(node.start, node.end),
    }));
  return {
    passed: target === "rows" && states[0].node.arguments[0]?.value === 3,
    events,
    directArrayStatement: tree.component.body.body.includes(
      array.parents.findLast((node) => node.type === "VariableDeclaration"),
    ),
  };
}

export function structuralEvidence(records) {
  const stateHooks = {};
  const concurrentMotion = {};
  try {
    for (const mode of ["U", "B", "S", "M0", "M1"]) {
      stateHooks[mode] = stateHookEvidence(
        records.find((record) => record.fixture === "state" && record.mode === mode).code,
      );
    }
    for (const mode of ["B", "S", "M0", "M1"]) {
      concurrentMotion[mode] = suspensionMotionEvidence(
        records.find((record) => record.fixture === "transition-motion" && record.mode === mode)
          .code,
      );
      const expected =
        mode === "B" || mode === "M0"
          ? ["allocate-rows", "useState(3)", "use(resource.promise)", "rows.push(payload)"]
          : ["useState(3)", "use(resource.promise)", "allocate-rows", "rows.push(payload)"];
      concurrentMotion[mode].expected = expected;
      concurrentMotion[mode].passed &&=
        JSON.stringify(concurrentMotion[mode].events?.map((event) => event.kind))
        === JSON.stringify(expected);
      if (mode === "M0" || mode === "M1") {
        concurrentMotion[mode].passed &&= concurrentMotion[mode].directArrayStatement;
      }
    }
    return {
      passed: [...Object.values(stateHooks), ...Object.values(concurrentMotion)].every(
        (item) => item.passed,
      ),
      stateHooks,
      concurrentMotion,
    };
  } catch (error) {
    return { passed: false, stateHooks, concurrentMotion, error: error.message };
  }
}
