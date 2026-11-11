import { useState } from 'react';
import { Probe } from '@harness/runtime';

function firstSite(fail) {
  if (fail) throw new Error('first throwing site');
  return 'first-ok';
}

function secondSite(fail) {
  if (fail) throw new Error('second throwing site');
  return 'second-ok';
}

export function Component({ session, visible, failFirst, failSecond }) {
  'use memo';
  const [local, setLocal] = useState(9);
  let values = ['hidden'];
  if (visible) {
    const first = firstSite(failFirst);
    const second = secondSite(failSecond);
    values = [first, second];
  }
  const advance = () => setLocal((current) => current + 1);
  return <Probe session={session} data={{ visible, local, values }} actions={{ advance }} />;
}
