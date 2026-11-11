import { useState, useSyncExternalStore } from 'react';
import { Probe } from '@harness/runtime';

export function Component({ session, store }) {
  'use memo';
  const prefix = ['store'];
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [local, setLocal] = useState(2);
  const output = [prefix[0], snapshot.version, snapshot.value, local];
  const advance = () => setLocal((current) => current + 1);
  const read = () => `${output[1]}:${output[2]}:${output[3]}`;
  return <Probe session={session} data={{ snapshot, local, output }} actions={{ advance, read }} />;
}
