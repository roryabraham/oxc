// @enableInstructionReordering:true
import {useState} from 'react';

function Component({value}) {
  const makeValue = () => ({value});
  useState(0);
  const result = makeValue();
  return result;
}
