// @enableInstructionReordering:true
import {useState} from 'react';

function Component({x, y}) {
  const a = {};
  const b = {};
  useState(0);
  a.value = x;
  b.value = y;
  return {a, b};
}
