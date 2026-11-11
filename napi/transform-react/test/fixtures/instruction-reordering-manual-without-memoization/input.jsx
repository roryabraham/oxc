import {useMemo, useState} from 'react';

export function Component({value}) {
  const result = useMemo(() => ({value}), [value]);
  useState(0);
  return <div result={result} />;
}
