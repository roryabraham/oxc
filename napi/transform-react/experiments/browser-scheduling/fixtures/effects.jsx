import { useEffect, useLayoutEffect, useState } from 'react';
import { Probe } from '@harness/runtime';

export function Component({ session, scope, noise }) {
  'use memo';
  const prefix = [scope];
  const [count, setCount] = useState(0);
  const dependency = { scope: prefix[0], count };
  useLayoutEffect(() => session.resources.open('layout', dependency), [session, dependency]);
  useEffect(() => session.resources.open('passive', dependency), [session, dependency]);
  const advance = () => setCount((current) => current + 1);
  return <Probe session={session} data={{ dependency, count, noise }} actions={{ advance }} />;
}
