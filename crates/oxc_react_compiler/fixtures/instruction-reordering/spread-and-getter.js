// @enableInstructionReordering:true
import {useState} from 'react';

function Component({source}) {
  const object = {...source};
  const array = [...source.items];
  const value = source.value;
  useState(0);
  return {object, array, value};
}
