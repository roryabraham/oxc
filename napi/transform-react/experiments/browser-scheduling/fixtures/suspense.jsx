import { use, useEffect, useState } from 'react';
import { Probe } from '@harness/runtime';

export function Component({ session, resource }) {
  'use memo';
  const allocated = [resource.key, 'pending'];
  const [local, setLocal] = useState(11);
  const payload = use(resource.promise);
  const dependency = { key: allocated[0], payload, local };
  useEffect(() => session.resources.open('suspense', dependency), [session, dependency]);
  const advance = () => setLocal((current) => current + 1);
  return (
    <Probe
      session={session}
      data={{ key: resource.key, payload, local, allocated, dependency }}
      actions={{ advance }}
    />
  );
}
