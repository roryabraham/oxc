// @enableInstructionReordering:true
function Component({left, right}) {
  const a = [left.value];
  const b = [right.value];
  const n = b[0];
  return a[0] + n;
}
