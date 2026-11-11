// @enableInstructionReordering:true
import {useState} from 'react';

function Component({value}) {
  let result;
  const items = (result = [value], result);
  useState(0);
  return {items, result};
}
