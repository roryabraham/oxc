// @enableInstructionReordering:true
import {useState} from 'react';

function Component({x, y}) {
  const items = [];
  items.push(x);
  useState(0);
  items.push(y);
  return items;
}
