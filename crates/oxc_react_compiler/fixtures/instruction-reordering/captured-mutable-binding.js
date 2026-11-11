// @enableInstructionReordering:true
import {useState} from 'react';

function Component({value}) {
  let current = value;
  const read = () => current;
  const before = [read()];
  current = value + 1;
  useState(0);
  return {before, after: read()};
}
