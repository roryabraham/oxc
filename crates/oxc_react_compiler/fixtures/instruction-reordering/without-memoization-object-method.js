// @enableInstructionReordering:true @disableMemoizationForTesting:true
function Component() {
  const object = {method() { return 1; }};
  return object.method();
}
