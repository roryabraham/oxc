// @enableInstructionReordering:true
import {useState} from 'react';

function Component({value}) {
  let current = value;
  const before = [current];
  current = value + 1;
  useState(0);
  return {before, current};
}
