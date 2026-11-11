// @enableInstructionReordering:true
import {use} from 'react';

function Component({promise, fail}) {
  const items = [];
  const value = use(promise);
  if (fail) {
    throw new Error('failed');
  }
  items.push(value);
  return items;
}
