// @enableInstructionReordering:true @disableMemoizationForTesting:true
function Component({left, right}) {
  const first = left();
  const a = [first];
  const second = right();
  const b = [second];
  const n = b[0];
  return a[0] + n;
}
