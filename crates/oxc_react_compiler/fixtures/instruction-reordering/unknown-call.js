// @enableInstructionReordering:true
import {useState} from 'react';
import {build, finish} from 'shared-runtime';

function Component({value}) {
  const items = build(value);
  useState(0);
  return finish(items);
}
