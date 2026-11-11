// @enableInstructionReordering:true @validatePreserveExistingMemoizationGuarantees
import {useMemo, useState} from 'react';

function Component({value}) {
  const result = useMemo(() => ({value}), [value]);
  useState(0);
  return result;
}
