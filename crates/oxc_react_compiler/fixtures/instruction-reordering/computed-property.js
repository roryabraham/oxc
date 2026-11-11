// @enableInstructionReordering:true
import {useState} from 'react';

function Component({key, value, prototype}) {
  const object = {[key]: value};
  const inherited = {__proto__: prototype};
  useState(0);
  return {object, inherited};
}
