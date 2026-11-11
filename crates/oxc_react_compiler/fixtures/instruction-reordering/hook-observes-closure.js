// @enableInstructionReordering:true
import {useObserve} from 'shared-runtime';

function Component({value}) {
  const items = [];
  const read = () => items.length;
  useObserve(read);
  items.push(value);
  return items;
}
