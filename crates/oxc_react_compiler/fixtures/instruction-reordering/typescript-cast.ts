// @enableInstructionReordering:true
import {useState} from 'react';

function Component({value}: {value: number}) {
  const items = [] as number[];
  const alias = items satisfies number[];
  useState(0);
  alias.push(value);
  return items;
}
