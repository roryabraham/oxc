import { useState } from 'react';
import { Probe } from '@harness/runtime';

export function Component({ session, value, revision }) {
  'use memo';
  const prefix = [value, revision];
  const [count, setCount] = useState(0);
  const row = [value, count];
  const packet = { prefix, row, revision };
  const describe = () => `${packet.row[0]}:${packet.row[1]}:${packet.revision}`;
  const helpers = [describe, () => [prefix[0], row[1], prefix[1]]];
  const advance = () => setCount((current) => current + 1);
  const capturedAdvance = () => setCount(count + 2);
  return (
    <Probe
      session={session}
      data={{ value, revision, count, prefix, row, packet, helpers }}
      actions={{ advance, capturedAdvance, describe, copy: helpers[1] }}
    />
  );
}
