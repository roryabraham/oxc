// @enableInstructionReordering:true
import {useState} from 'react';
import {observe} from 'shared-runtime';

function Component({value}) {
  const makeValue = function named() { return {value}; };
  const name = makeValue.name;
  const prototype = makeValue.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(makeValue, 'name');
  const observed = observe(makeValue);
  useState(0);
  return {name, prototype, descriptor, observed, result: makeValue()};
}
