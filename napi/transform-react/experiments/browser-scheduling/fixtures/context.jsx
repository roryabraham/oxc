import { useContext, useState } from 'react';
import { PaletteContext, Probe } from '@harness/runtime';

export function Component({ session, label, initial }) {
  'use memo';
  const palette = useContext(PaletteContext);
  const prefix = [palette.name, label];
  const [value, setValue] = useState(initial);
  const output = { prefix, value, text: `${palette.name}:${label}:${value}` };
  const step = () => setValue((current) => current + 1);
  const read = () => output.text;
  return <Probe session={session} label={label} data={{ palette, value, output }} actions={{ step, read }} />;
}
