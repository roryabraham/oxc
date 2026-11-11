// @enableInstructionReordering:true
import {useState} from 'react';

function Component({value}) {
  const makeValue = function recursive(depth) {
    return depth > 0 ? recursive(depth - 1) : {value};
  };
  useState(0);
  return makeValue(2);
}
