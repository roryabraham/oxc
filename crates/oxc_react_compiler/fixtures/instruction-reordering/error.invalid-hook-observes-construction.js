// @enableInstructionReordering:true
import {useState} from 'react';
import {useObserve} from 'shared-runtime';

function Component({value}) {
  const items = [];
  const alias = items;
  useObserve(alias);
  useState(0);
  items.push(value);
  return items;
}
