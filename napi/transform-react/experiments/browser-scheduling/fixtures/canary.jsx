import { useState } from 'react';
import { Probe } from '@harness/runtime';

export function Component({ session, value, tick }) {
  'use memo';
  const beforeHook = [value, 'before'];
  const [count, setCount] = useState(7);
  const afterHook = [value, 'after'];
  const increment = () => setCount((current) => current + 1);
  return (
    <Probe
      session={session}
      data={{ beforeHook, afterHook, count, tick }}
      actions={{ increment }}
    />
  );
}
