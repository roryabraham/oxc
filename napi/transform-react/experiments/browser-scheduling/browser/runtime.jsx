/* oxlint-disable react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-jsx-as-prop -- Uncompiled test drivers intentionally provide fresh commit observations. */
import {
  Component,
  createContext,
  Suspense,
  useLayoutEffect,
  useState,
  useTransition,
} from "react";

export const PaletteContext = createContext({ name: "red", epoch: 0 });
const emptyActions = {};

// This module is bundled by esbuild, never sent through the React Compiler.
export function Probe({ session, label = "main", data, actions = emptyActions }) {
  useLayoutEffect(() => session.capture(label, data, actions));
  return (
    <section data-probe={label}>
      <pre>
        {JSON.stringify(data, (_key, value) =>
          typeof value === "function" ? "[function]" : value,
        )}
      </pre>
      {Object.entries(actions).map(([name, action]) => (
        <button key={name} data-action={name} onClick={action}>
          {name}
        </button>
      ))}
    </section>
  );
}

export function TransitionDriver({ session, Child, initialResource }) {
  const [resource, setResource] = useState(initialResource);
  const [urgent, setUrgent] = useState(0);
  const [pending, startTransition] = useTransition();
  return (
    <>
      <Probe
        session={session}
        label="shell"
        data={{ urgent, pending, requested: resource.key }}
        actions={{
          begin: (next) => startTransition(() => setResource(next)),
          replace: (next) => setResource(next),
          urgent: () => setUrgent((value) => value + 1),
        }}
      />
      <Suspense fallback={<Probe session={session} label="fallback" data={{ waiting: true }} />}>
        <Child session={session} resource={resource} />
      </Suspense>
    </>
  );
}

export function ContextDriver({ session, Child }) {
  const [palette, setPalette] = useState({ name: "red", epoch: 0 });
  const [leftKey, setLeftKey] = useState(0);
  return (
    <>
      <Probe
        session={session}
        label="controls"
        data={{ palette, leftKey }}
        actions={{
          recolor: () => setPalette((value) => ({ name: "blue", epoch: value.epoch + 1 })),
          remountLeft: () => setLeftKey((value) => value + 1),
        }}
      />
      <PaletteContext.Provider value={palette}>
        <Child key={`left-${leftKey}`} session={session} label="left" initial={5} />
        <Child key="right" session={session} label="right" initial={50} />
      </PaletteContext.Provider>
    </>
  );
}

export class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    this.props.session.boundaryErrors.push(error.message);
  }

  render() {
    return this.state.error ? (
      <Probe
        session={this.props.session}
        label="error"
        data={{ message: this.state.error.message }}
      />
    ) : (
      this.props.children
    );
  }
}
