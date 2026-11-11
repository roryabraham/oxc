// @enableInstructionReordering:true
import {useState} from 'react';

function Component({value}) {
  const stable = value;
  const helper = () => ({stable});
  useState(0);
  return helper();
}
