// @enableInstructionReordering:true
import {useState} from 'react';

function Component({value}) {
  'use no memo';
  const items = [];
  useState(0);
  items.push(value);
  return items;
}
