// @enableInstructionReordering:true
import {useState} from 'react';

function Component({value}) {
  const a = [];
  const b = [];
  const alias = a;
  const [count] = useState(alias.length);
  a.push(count);
  b.push(value);
  return {a, b};
}
