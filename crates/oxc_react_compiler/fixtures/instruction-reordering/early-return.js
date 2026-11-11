// @enableInstructionReordering:true
import {useState} from 'react';

function Component({hidden, value}) {
  useState(0);
  if (hidden) {
    return null;
  }
  const items = [];
  items.push(value);
  return items;
}
