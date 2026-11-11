import { use, useState } from 'react';
import { Probe } from '@harness/runtime';

export function Component({ session, resource }) {
  'use memo';
  const request = [resource.key, 'request'];
  const [local, setLocal] = useState(3);
  const payload = use(resource.promise);
  const output = { request, payload, local };
  const read = () => `${output.request[0]}:${output.payload}:${output.local}`;
  const advance = () => setLocal((current) => current + 1);
  return <Probe session={session} data={{ request, payload, local, output }} actions={{ read, advance }} />;
}
