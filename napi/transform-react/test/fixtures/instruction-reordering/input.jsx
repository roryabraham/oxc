import {useState} from 'react';

export function Component({x, y}) {
  const a = [];
  const b = [];
  useState(0);
  a.push(x);
  b.push(y);
  return <div a={a} b={b} />;
}
