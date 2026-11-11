import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";

export function snapshot(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === "function" ? "[function]" : item)),
  );
}

export function errorDetails(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack,
    details: error?.details,
  };
}

export class Session {
  checks = 0;
  commits = [];
  current = new Map();
  activeProbes = new Map();
  outcomes = [];
  observations = {};
  rootErrors = [];
  caughtErrors = [];
  boundaryErrors = [];
  expectedCaught = [];
  unmounted = false;

  constructor(profile) {
    this.profile = profile;
    this.container = document.createElement("div");
    document.getElementById("mounts").append(this.container);
    this.root = createRoot(this.container, {
      onCaughtError: (error) => this.caughtErrors.push(errorDetails(error)),
      onUncaughtError: (error) => this.rootErrors.push(errorDetails(error)),
      onRecoverableError: (error) => this.rootErrors.push(errorDetails(error)),
    });
    this.resources = this.createResources();
  }

  check(condition, message, details) {
    this.checks += 1;
    if (condition) return;
    const error = new Error(message);
    error.name = "InvariantFailure";
    error.details = details;
    throw error;
  }

  equal(actual, expected, message) {
    this.check(JSON.stringify(actual) === JSON.stringify(expected), message, { actual, expected });
  }

  checkpoint(name, actual, expected) {
    this.equal(actual, expected, name);
    this.outcomes.push({ name, value: snapshot(actual) });
  }

  capture(label, data, actions) {
    const commit = {
      index: this.commits.length,
      label,
      data: snapshot(data),
      reference: data,
      actions,
      cleanups: 0,
    };
    this.commits.push(commit);
    this.current.set(label, { data, actions });
    this.activeProbes.set(label, commit);
    return () => {
      commit.cleanups += 1;
      if (this.activeProbes.get(label) === commit) this.activeProbes.delete(label);
    };
  }

  latest(label = "main") {
    const value = this.current.get(label);
    this.check(Boolean(value), `A committed ${label} Probe exists`);
    this.check(this.activeProbes.has(label), `The ${label} Probe is currently mounted`);
    const rendered = this.container.querySelector(`[data-probe="${label}"] pre`);
    this.equal(
      rendered?.textContent,
      JSON.stringify(snapshot(value.data)),
      `The ${label} DOM matches its committed data`,
    );
    return value;
  }

  async render(element) {
    await act(async () => {
      this.root.render(this.profile.strict ? createElement(StrictMode, null, element) : element);
    });
  }

  async change(callback) {
    await act(async () => {
      await callback();
    });
  }

  async click(label, action) {
    const button = this.container.querySelector(
      `[data-probe="${label}"] button[data-action="${action}"]`,
    );
    this.check(button instanceof HTMLButtonElement, `Mounted ${label}.${action} button exists`);
    await this.change(() => button.click());
  }

  createResources() {
    const active = new Map();
    const events = [];
    const setups = [];
    const violations = [];
    return {
      active,
      events,
      setups,
      violations,
      open: (kind, payload) => {
        const committed = this.current.get("main")?.data.dependency;
        const record = {
          id: setups.length,
          kind,
          payload: snapshot(payload),
          reference: payload,
          cleanups: 0,
          commit: this.commits.length - 1,
        };
        if (JSON.stringify(committed) !== JSON.stringify(payload)) {
          violations.push({
            message: "Effect capture does not match committed dependency",
            record,
          });
        }
        setups.push(record);
        active.set(record.id, record);
        events.push({
          type: "setup",
          id: record.id,
          kind,
          payload: record.payload,
          commit: record.commit,
        });
        return () => {
          record.cleanups += 1;
          if (!active.delete(record.id)) {
            violations.push({ message: "Duplicate cleanup", id: record.id });
          }
          events.push({ type: "cleanup", id: record.id, kind, payload: snapshot(payload) });
        };
      },
    };
  }

  assertResources(kinds, expected) {
    this.equal(this.resources.violations, [], "Effect setup/cleanup protocol has no violations");
    const active = [...this.resources.active.values()].sort((left, right) =>
      left.kind.localeCompare(right.kind),
    );
    this.equal(
      active.map((item) => item.kind),
      [...kinds].sort((left, right) => left.localeCompare(right)),
      "Exactly the expected resources are active",
    );
    for (const resource of active) {
      this.equal(
        resource.payload,
        expected,
        `${resource.kind} captures current committed dependency`,
      );
    }
  }

  async unmount() {
    if (this.unmounted) return;
    await this.change(() => this.root.unmount());
    this.unmounted = true;
    this.container.remove();
  }

  verifyCleanup() {
    this.equal(this.rootErrors, [], "No uncaught or recoverable React root errors");
    this.equal(
      this.caughtErrors.map((error) => error.message),
      this.expectedCaught,
      "Only expected boundary errors are caught",
    );
    this.equal(
      this.boundaryErrors,
      this.expectedCaught,
      "Error boundary catches the expected errors",
    );
    this.equal(this.activeProbes.size, 0, "No Probe remains mounted");
    this.equal(this.resources.active.size, 0, "No effect resources leak after unmount");
    this.equal(
      this.resources.violations,
      [],
      "All resources respect committed setup/cleanup protocol",
    );
    for (const commit of this.commits) {
      this.equal(commit.cleanups, 1, `Committed Probe ${commit.index} has one cleanup`);
      this.equal(
        snapshot(commit.reference),
        commit.data,
        `Committed output ${commit.index} never mutates`,
      );
    }
    for (const resource of this.resources.setups) {
      this.equal(resource.cleanups, 1, `Resource ${resource.id} has one paired cleanup`);
      this.equal(
        snapshot(resource.reference),
        resource.payload,
        `Resource ${resource.id} capture never mutates`,
      );
    }
  }

  report() {
    return {
      checks: this.checks,
      outcomes: this.outcomes,
      observations: this.observations,
      commits: this.commits.map(
        ({ reference: _reference, actions: _actions, ...commit }) => commit,
      ),
      resources: this.resources.events,
      caughtErrors: this.caughtErrors,
      boundaryErrors: this.boundaryErrors,
      rootErrors: this.rootErrors,
      mountedAfterCleanup: this.activeProbes.size,
      resourcesAfterCleanup: this.resources.active.size,
    };
  }
}

export function deferredResource(key) {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { key, promise, resolve, reject };
}

export function readyResource(key, value) {
  return { key, promise: Promise.resolve(value) };
}

export function createStore() {
  let value = { version: 0, value: "zero" };
  const listeners = new Set();
  const ledger = { setups: 0, cleanups: 0, duplicateCleanups: 0 };
  return {
    ledger,
    listeners,
    getSnapshot: () => value,
    subscribe: (listener) => {
      ledger.setups += 1;
      listeners.add(listener);
      return () => {
        ledger.cleanups += 1;
        if (!listeners.delete(listener)) ledger.duplicateCleanups += 1;
      };
    },
    set: (next) => {
      value = { version: value.version + 1, value: next };
      for (const listener of listeners) listener();
    },
  };
}
