// @enableInstructionReordering:true @disableMemoizationForTesting:true
function Component({left, right}) {
  const a = [left.value as number] satisfies number[];
  const b = [right.value as number] satisfies number[];
  const n = b[0];
  return a[0] + n;
}
