import { use, useState } from 'react';
import { Probe } from '@harness/runtime';

export function Component({ session, resource }) {
  'use memo';
  const rows = [];
  const [local, setLocal] = useState(3);
  const payload = use(resource.promise);
  rows.push(payload);
  const request = [resource.key, 'request'];
  const output = { request, payload, local, rows };
  const read = () => `${output.request[0]}:${output.payload}:${output.local}`;
  const advance = () => setLocal((current) => current + 1);
  return <Probe session={session} data={{ request, payload, local, rows, output }} actions={{ read, advance }} />;
}
