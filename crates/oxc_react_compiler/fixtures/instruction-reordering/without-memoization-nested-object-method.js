// @enableInstructionReordering:true @disableMemoizationForTesting:true
import {useState} from 'react';

function Component({value}) {
  const build = () => ({method() { return {nested: {method() { return value; }}}; }});
  useState(0);
  return build().method().nested.method();
}
