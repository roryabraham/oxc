// @enableInstructionReordering:false
import {useState} from 'react';

function Component({x, y}) {
  const a = [];
  const b = [];
  useState(0);
  a.push(x);
  b.push(y);
  return {a, b};
}
