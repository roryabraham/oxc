import { useCallback, useMemo, useState } from 'react';
import { Probe } from '@harness/runtime';

export function Component({ session, id, noise }) {
  'use memo';
  const header = [id, 'header'];
  const [count, setCount] = useState(0);
  const token = useMemo(() => ({ id, tag: 'manual' }), [id]);
  const read = useCallback(() => `${token.id}:${count}`, [token, count]);
  const step = useCallback(() => setCount((current) => current + 1), []);
  return <Probe session={session} data={{ header, token, count, noise }} actions={{ read, step }} />;
}
