// @enableInstructionReordering:true
import {useState} from 'react';

function Component({Object, globalThis, value}) {
  const items = [];
  useState(0);
  items.push(value, Object, globalThis);
  return items;
}
