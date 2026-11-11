import { useState } from 'react';
import { Probe } from '@harness/runtime';

export function Component({ session, seed }) {
  'use memo';
  const leftAllocation = [seed, 'left'];
  const [left, setLeft] = useState(2);
  const rightAllocation = [seed, 'right'];
  const [right, setRight] = useState(30);
  const leftStep = () => setLeft((current) => current + 1);
  const rightStep = () => setRight((current) => current + 10);
  const capturedLeft = () => setLeft(left + 5);
  const capturedRight = () => setRight(right + 7);
  return (
    <Probe
      session={session}
      data={{ left, right, leftAllocation, rightAllocation }}
      actions={{ leftStep, rightStep, capturedLeft, capturedRight }}
    />
  );
}
