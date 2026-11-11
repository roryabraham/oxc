// @enableInstructionReordering:true @outputMode:"lint"
import {useState} from 'react';

function Component({value}) {
  const items = [];
  useState(0);
  items.push(value);
  return items;
}
