// @enableInstructionReordering:true
import {useState} from 'react';

function Component({values}) {
  const rows = [];
  useState(0);
  for (let index = 0; index < values.length; index++) {
    rows.push({index, score: values[index] * values[index]});
  }
  return rows;
}
