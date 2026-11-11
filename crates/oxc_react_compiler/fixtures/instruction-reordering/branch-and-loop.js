// @enableInstructionReordering:true
import {useState} from 'react';

function Component({enabled, values}) {
  const items = [];
  if (enabled) {
    items.push('enabled');
  }
  useState(0);
  for (const value of values) {
    items.push(value);
  }
  return items;
}
