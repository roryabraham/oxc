import { use, useState } from 'react';
import { Probe } from '@harness/runtime';

export function Component({ session, visible, resource }) {
  'use memo';
  const [local, setLocal] = useState(4);
  const advance = () => setLocal((current) => current + 1);
  if (!visible) {
    return <Probe session={session} data={{ visible, local, key: 'hidden', rows: [] }} actions={{ advance }} />;
  }
  const rows = [];
  const payload = use(resource.promise);
  rows.push(payload);
  return <Probe session={session} data={{ visible, local, key: resource.key, rows }} actions={{ advance }} />;
}
