/* oxlint-disable no-await-in-loop -- Each React act depends on preceding commits; cases must not overlap. */
import { createElement as h, memo, Suspense, version as reactVersion } from "react";
import { flushSync, version as reactDomVersion } from "react-dom";
import { modes, profiles, scenarios } from "../catalog.mjs";
import { ContextDriver, ErrorBoundary, Probe, TransitionDriver } from "./runtime.jsx";
import { createStore, deferredResource, errorDetails, readyResource, Session } from "./session.mjs";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const tests = {
  async "motion-cache-canary"(session, Component, mode) {
    const mount = (value, tick) => session.render(h(Component, { session, value, tick }));
    await mount("alpha", 0);
    const first = session.latest().data;
    session.checkpoint("initial", first, {
      beforeHook: ["alpha", "before"],
      afterHook: ["alpha", "after"],
      count: 7,
      tick: 0,
    });
    await mount("alpha", 1);
    const second = session.latest().data;
    const cached = mode.id === "B" || mode.id === "S";
    session.equal(
      second.beforeHook === first.beforeHook,
      cached,
      "Before-hook allocation has the expected cache identity",
    );
    session.equal(
      second.afterHook === first.afterHook,
      cached,
      "After-hook allocation has the expected cache identity",
    );
    await session.click("main", "increment");
    const third = session.latest().data;
    session.checkpoint(
      "state event",
      { count: third.count, tick: third.tick },
      { count: 8, tick: 1 },
    );
    session.equal(
      third.beforeHook === second.beforeHook,
      cached,
      "Independent state update preserves only compiled caches",
    );
    await mount("beta", 2);
    const fourth = session.latest().data;
    session.checkpoint("dependency update", fourth, {
      beforeHook: ["beta", "before"],
      afterHook: ["beta", "after"],
      count: 8,
      tick: 2,
    });
    session.check(
      fourth.beforeHook !== third.beforeHook,
      "Dependency invalidation allocates a fresh before-hook array",
    );
    session.check(
      fourth.afterHook !== third.afterHook,
      "Dependency invalidation allocates a fresh after-hook array",
    );
    session.observations.memoizationIdentityVerified = cached;
    session.observations.noMemoIdentityVerified = !cached;
  },

  async "state-callsite-order"(session, Component) {
    await session.render(h(Component, { session, seed: "seed" }));
    const retained = session.latest().actions;
    const values = () => {
      const { left, right } = session.latest().data;
      return { left, right };
    };
    session.checkpoint("initial callsites", values(), { left: 2, right: 30 });
    for (let index = 0; index < 12; index += 1) {
      await session.click("main", "leftStep");
      session.checkpoint(`left event ${index}`, values(), {
        left: 3 + index,
        right: 30 + 10 * index,
      });
      await session.click("main", "rightStep");
      session.checkpoint(`right event ${index}`, values(), {
        left: 3 + index,
        right: 40 + 10 * index,
      });
    }
    await session.change(() => retained.capturedLeft());
    session.checkpoint("retained left captured event", values(), { left: 7, right: 150 });
    await session.change(() => retained.capturedRight());
    session.checkpoint("retained right captured event", values(), { left: 7, right: 37 });
    await session.change(() => {
      retained.leftStep();
      retained.rightStep();
    });
    session.checkpoint("retained functional events", values(), { left: 8, right: 47 });
    await session.click("main", "capturedLeft");
    await session.click("main", "capturedRight");
    session.checkpoint("current captured events", values(), { left: 13, right: 54 });
  },

  async "retained-allocations-handlers"(session, Component) {
    const retained = [];
    let count = 0;
    for (let revision = 0; revision < 8; revision += 1) {
      const value = `value-${revision}`;
      await session.render(h(Component, { session, value, revision }));
      const current = session.latest();
      const expected = `${value}:${count}:${revision}`;
      session.checkpoint(`current helper ${revision}`, current.actions.describe(), expected);
      session.equal(
        current.data.helpers[0](),
        expected,
        "Helper array closes over current allocations",
      );
      session.equal(
        current.actions.copy(),
        [value, count, revision],
        "Current helper copy uses current values",
      );
      retained.push({ current, expected, copy: [value, count, revision] });
      await session.click("main", "advance");
      count += 1;
      session.checkpoint(
        `event helper ${revision}`,
        session.latest().actions.describe(),
        `${value}:${count}:${revision}`,
      );
      for (const old of retained) {
        session.equal(
          old.current.actions.describe(),
          old.expected,
          "Retained event reads its committed allocation",
        );
        session.equal(
          old.current.data.helpers[0](),
          old.expected,
          "Retained helper array reads its committed allocation",
        );
        session.equal(
          old.current.actions.copy(),
          old.copy,
          "Retained helper copy reads prior committed values",
        );
      }
    }
    await session.change(() => retained[0].current.actions.capturedAdvance());
    session.checkpoint(
      "retained captured state update",
      session.latest().actions.describe(),
      "value-7:2:7",
    );
    await session.change(() => retained[0].current.actions.advance());
    session.checkpoint(
      "retained functional state update",
      session.latest().actions.describe(),
      "value-7:3:7",
    );
  },

  async "layout-effect-resources"(session, Component) {
    for (let noise = 0; noise < 5; noise += 1) {
      await session.render(h(Component, { session, scope: "first", noise }));
      session.assertResources(["layout", "passive"], { scope: "first", count: 0 });
      session.checkpoint(`unrelated prop ${noise}`, session.latest().data, {
        dependency: { scope: "first", count: 0 },
        count: 0,
        noise,
      });
    }
    for (let count = 1; count <= 4; count += 1) {
      await session.click("main", "advance");
      session.assertResources(["layout", "passive"], { scope: "first", count });
      session.checkpoint(`effect state ${count}`, session.latest().data.dependency, {
        scope: "first",
        count,
      });
    }
    await session.render(h(Component, { session, scope: "second", noise: 5 }));
    session.assertResources(["layout", "passive"], { scope: "second", count: 4 });
    session.checkpoint("effect dependency change", session.latest().data.dependency, {
      scope: "second",
      count: 4,
    });
    session.observations.setupsByKind = Object.fromEntries(
      ["layout", "passive"].map((kind) => [
        kind,
        session.resources.setups.filter((item) => item.kind === kind).length,
      ]),
    );
  },

  async "transition-resume-urgent"(session, Component) {
    const initial = readyResource("initial", "one");
    const pending = deferredResource("later");
    await session.render(
      h(TransitionDriver, { session, Child: Component, initialResource: initial }),
    );
    const retained = session.latest();
    session.checkpoint("initial transition content", retained.actions.read(), "initial:one:3");
    const initialCommits = session.commits.length;
    await session.change(() => session.latest("shell").actions.begin(pending));
    session.check(session.latest("shell").data.pending, "Transition has a committed pending state");
    session.equal(
      session.latest().actions.read(),
      "initial:one:3",
      "Suspending transition retains committed content",
    );
    session.check(
      !session.activeProbes.has("fallback"),
      "Transition does not replace mounted content with fallback",
    );
    await session.click("shell", "urgent");
    session.checkpoint(
      "urgent sibling while suspended",
      {
        urgent: session.latest("shell").data.urgent,
        pending: session.latest("shell").data.pending,
        content: session.latest().actions.read(),
      },
      { urgent: 1, pending: true, content: "initial:one:3" },
    );
    await session.click("main", "advance");
    session.checkpoint(
      "urgent local state while suspended",
      session.latest().actions.read(),
      "initial:one:4",
    );
    await session.change(() => pending.resolve("two"));
    session.checkpoint(
      "transition retry commit",
      {
        urgent: session.latest("shell").data.urgent,
        pending: session.latest("shell").data.pending,
        content: session.latest().actions.read(),
      },
      { urgent: 1, pending: false, content: "later:two:4" },
    );
    session.equal(
      retained.actions.read(),
      "initial:one:3",
      "Retained handler survives suspended cache writes",
    );
    session.check(
      session.commits.slice(initialCommits).every((commit) => commit.label !== "fallback"),
      "No fallback commits after the transition starts from mounted content",
    );
  },

  async "transition-abandon"(session, Component) {
    const pending = deferredResource("abandoned");
    await session.render(
      h(TransitionDriver, {
        session,
        Child: Component,
        initialResource: readyResource("initial", "one"),
      }),
    );
    const retained = session.latest();
    await session.change(() => session.latest("shell").actions.begin(pending));
    session.check(
      session.latest("shell").data.pending,
      "Abandoned transition first commits pending state",
    );
    await session.click("shell", "urgent");
    await session.change(() => {
      flushSync(() => session.latest("shell").actions.replace(readyResource("winner", "three")));
    });
    session.checkpoint(
      "urgent replacement commits",
      {
        urgent: session.latest("shell").data.urgent,
        content: session.latest().actions.read(),
      },
      { urgent: 1, content: "winner:three:3" },
    );
    await session.change(() => pending.resolve("stale"));
    session.checkpoint(
      "abandoned promise resolves",
      {
        urgent: session.latest("shell").data.urgent,
        pending: session.latest("shell").data.pending,
        content: session.latest().actions.read(),
      },
      { urgent: 1, pending: false, content: "winner:three:3" },
    );
    session.check(
      session.commits.every(
        (commit) => commit.label !== "main" || commit.data.request[0] !== "abandoned",
      ),
      "Abandoned content never commits",
    );
    session.equal(
      retained.actions.read(),
      "initial:one:3",
      "Abandoning a render preserves retained handlers",
    );
  },

  async "suspense-initial-retry"(session, Component) {
    const resource = deferredResource("initial");
    await session.render(suspenseTree(session, Component, resource));
    assertInitialSuspension(session);
    await session.change(() => resource.resolve("resolved"));
    session.checkpoint("initial retry", suspenseValue(session), {
      key: "initial",
      payload: "resolved",
      local: 11,
    });
    session.assertResources(["suspense"], { key: "initial", payload: "resolved", local: 11 });
    session.check(!session.activeProbes.has("fallback"), "Retry removes the committed fallback");
    await session.click("main", "advance");
    session.checkpoint("retry state event", suspenseValue(session), {
      key: "initial",
      payload: "resolved",
      local: 12,
    });
    session.assertResources(["suspense"], { key: "initial", payload: "resolved", local: 12 });
  },

  async "suspense-unmount"(session, Component) {
    const resource = deferredResource("unmounted");
    await session.render(suspenseTree(session, Component, resource));
    assertInitialSuspension(session);
    await session.unmount();
    const commits = session.commits.length;
    await session.change(() => resource.resolve("too-late"));
    session.equal(
      session.commits.length,
      commits,
      "Resolution after unmount creates no new commits",
    );
    session.checkpoint(
      "unmounted resolution",
      {
        mainCommitted: session.current.has("main"),
        resourceSetups: session.resources.setups.length,
        mounted: session.activeProbes.size,
      },
      { mainCommitted: false, resourceSetups: 0, mounted: 0 },
    );
  },

  async "suspense-reject-recover"(session, Component) {
    const resource = deferredResource("reject");
    session.expectedCaught = ["resource rejected intentionally"];
    await session.render(
      h(ErrorBoundary, { session, key: "first" }, suspenseTree(session, Component, resource)),
    );
    assertInitialSuspension(session);
    await session.change(() => resource.reject(new Error("resource rejected intentionally")));
    session.checkpoint("error boundary commit", session.latest("error").data, {
      message: "resource rejected intentionally",
    });
    session.check(
      !session.current.has("main"),
      "Rejected initial render never commits main content",
    );
    session.equal(session.resources.setups.length, 0, "Rejected initial render creates no effects");
    await session.render(
      h(
        ErrorBoundary,
        { session, key: "recovered" },
        suspenseTree(session, Component, readyResource("recovered", "ok")),
      ),
    );
    session.checkpoint("keyed error recovery", suspenseValue(session), {
      key: "recovered",
      payload: "ok",
      local: 11,
    });
    session.assertResources(["suspense"], { key: "recovered", payload: "ok", local: 11 });
    session.check(!session.activeProbes.has("error"), "Recovery unmounts the error fallback");
  },

  async "context-keyed-instances"(session, Component) {
    await session.render(h(ContextDriver, { session, Child: memo(Component) }));
    const retainedLeft = session.latest("left");
    const values = () => ({
      left: session.latest("left").actions.read(),
      right: session.latest("right").actions.read(),
    });
    session.checkpoint("independent initial instances", values(), {
      left: "red:left:5",
      right: "red:right:50",
    });
    await session.click("left", "step");
    session.checkpoint("left-only state", values(), { left: "red:left:6", right: "red:right:50" });
    await session.click("controls", "recolor");
    session.checkpoint("context bypasses memo props", values(), {
      left: "blue:left:6",
      right: "blue:right:50",
    });
    await session.click("right", "step");
    session.checkpoint("right-only state", values(), {
      left: "blue:left:6",
      right: "blue:right:51",
    });
    await session.click("controls", "remountLeft");
    session.checkpoint("keyed remount", values(), { left: "blue:left:5", right: "blue:right:51" });
    await session.change(() => retainedLeft.actions.step());
    session.checkpoint("unmounted instance event", values(), {
      left: "blue:left:5",
      right: "blue:right:51",
    });
    session.equal(
      retainedLeft.actions.read(),
      "red:left:5",
      "Retained context closure keeps its committed context",
    );
  },

  async "external-store-invalidation"(session, Component) {
    const store = createStore();
    await session.render(h(Component, { session, store }));
    const retained = session.latest();
    session.checkpoint("initial store", retained.actions.read(), "0:zero:2");
    session.equal(store.listeners.size, 1, "One store subscription is active");
    for (let version = 1; version <= 16; version += 1) {
      await session.change(() => store.set(`value-${version}`));
      session.checkpoint(
        `external store ${version}`,
        session.latest().actions.read(),
        `${version}:value-${version}:2`,
      );
    }
    await session.click("main", "advance");
    session.checkpoint("independent hook update", session.latest().actions.read(), "16:value-16:3");
    session.equal(
      retained.actions.read(),
      "0:zero:2",
      "Retained handler keeps its old immutable store snapshot",
    );
    await session.unmount();
    const commits = session.commits.length;
    await session.change(() => store.set("after-unmount"));
    session.equal(session.commits.length, commits, "Store writes after unmount create no commits");
    session.equal(store.listeners.size, 0, "All store subscriptions are released");
    session.equal(store.ledger.duplicateCleanups, 0, "Store cleanup is never duplicated");
    session.equal(
      store.ledger.cleanups,
      store.ledger.setups,
      "Store setup/cleanup counts pair after unmount",
    );
    session.observations.subscriptionLedger = store.ledger;
    session.observations.parentRootRenders = 1;
  },

  async "manual-memo-contracts"(session, Component) {
    await session.render(h(Component, { session, id: "first", noise: 0 }));
    const first = session.latest();
    session.checkpoint("initial manual capture", first.actions.read(), "first:0");
    await session.render(h(Component, { session, id: "first", noise: 1 }));
    const second = session.latest();
    session.check(
      second.data.token === first.data.token,
      "Explicit useMemo preserves identity with unchanged dependencies",
    );
    session.check(
      second.actions.read === first.actions.read,
      "Explicit useCallback preserves identity with unchanged dependencies",
    );
    session.check(
      second.actions.step === first.actions.step,
      "Empty-dependency useCallback remains stable",
    );
    await session.click("main", "step");
    const third = session.latest();
    session.checkpoint("manual state dependency", third.actions.read(), "first:1");
    session.check(
      third.data.token === first.data.token,
      "Independent state does not invalidate explicit useMemo",
    );
    session.check(
      third.actions.read !== first.actions.read,
      "Explicit callback invalidates on state dependency",
    );
    session.check(
      third.actions.step === first.actions.step,
      "Functional callback retains empty-dependency identity",
    );
    await session.render(h(Component, { session, id: "second", noise: 2 }));
    const fourth = session.latest();
    session.checkpoint("manual prop dependency", fourth.actions.read(), "second:1");
    session.check(
      fourth.data.token !== first.data.token,
      "Explicit useMemo invalidates on prop dependency",
    );
    session.equal(
      first.actions.read(),
      "first:0",
      "Retained explicit callback keeps its committed captures",
    );
    await session.change(() => first.actions.step());
    session.checkpoint("retained manual event", session.latest().actions.read(), "second:2");
  },
};

function suspenseTree(session, Component, resource) {
  return h(
    Suspense,
    { fallback: h(Probe, { session, label: "fallback", data: { waiting: true } }) },
    h(Component, { session, resource }),
  );
}

function suspenseValue(session) {
  const { key, payload, local } = session.latest().data;
  return { key, payload, local };
}

function assertInitialSuspension(session) {
  session.check(session.activeProbes.has("fallback"), "Initial suspension commits a fallback");
  session.check(
    !session.current.has("main"),
    "Initial suspended render has no committed main output",
  );
  session.equal(
    session.resources.setups.length,
    0,
    "Initial suspended render starts no effect resources",
  );
}

function classify(results) {
  const byMode = Object.fromEntries(results.map((result) => [result.mode, result]));
  const passed = (id) => byMode[id].status === "pass";
  const labels = [];
  if (!passed("U")) labels.push("reference-or-harness-failure");
  if (passed("U") && !passed("B")) labels.push("baseline-compiler-failure");
  if (passed("U") && passed("B") && !passed("S")) labels.push("scheduler-counterexample");
  if (passed("U") && !passed("M0")) labels.push("no-memo-baseline-failure");
  if (passed("U") && passed("M0") && !passed("M1")) labels.push("scheduler-motion-counterexample");
  const passingOutcomes = results
    .filter((result) => result.status === "pass")
    .map((result) => JSON.stringify(result.outcomes));
  if (new Set(passingOutcomes).size > 1) labels.push("semantic-checkpoint-disagreement");
  if (results.some((result) => result.status === "compile-error")) {
    labels.push("compiler-diagnostic-or-emission-failure");
  }
  return labels.length ? labels : ["pass"];
}

async function runCase(scenario, mode, profile, entry) {
  if (!entry.Component) {
    return {
      scenario: scenario.id,
      fixture: scenario.fixture,
      mode: mode.id,
      profile: profile.id,
      status: "compile-error",
      errors: entry.errors,
      checks: 0,
      outcomes: [],
      commits: [],
    };
  }
  const session = new Session(profile);
  const errors = [];
  try {
    await tests[scenario.id](session, entry.Component, mode);
  } catch (error) {
    errors.push(errorDetails(error));
  } finally {
    try {
      await session.unmount();
      session.verifyCleanup();
    } catch (error) {
      errors.push(errorDetails(error));
    }
  }
  return {
    scenario: scenario.id,
    fixture: scenario.fixture,
    mode: mode.id,
    profile: profile.id,
    status: errors.length ? "fail" : "pass",
    errors,
    ...session.report(),
  };
}

export async function run(registry, metadata) {
  const results = [];
  const groups = [];
  const browserErrors = [];
  const consoleMessages = [];
  const recordError = (event) =>
    browserErrors.push(errorDetails(event.error ?? event.reason ?? event.message));
  window.addEventListener("error", recordError);
  window.addEventListener("unhandledrejection", recordError);
  // oxlint-disable-next-line no-console -- Capture browser warnings and errors as test failures.
  const originals = { error: console.error, warn: console.warn };
  for (const level of Object.keys(originals)) {
    console[level] = (...args) => {
      consoleMessages.push({ level, args: args.map((value) => String(value)) });
      originals[level](...args);
    };
  }
  try {
    if (reactVersion !== "19.2.3" || reactDomVersion !== "19.2.3") {
      throw new Error(`Expected React and ReactDOM 19.2.3, got ${reactVersion}/${reactDomVersion}`);
    }
    for (const profile of profiles) {
      for (const scenario of scenarios) {
        const groupResults = [];
        for (const mode of modes) {
          document.getElementById("status").textContent =
            `${profile.id} / ${scenario.id} / ${mode.id}`;
          const result = await runCase(
            scenario,
            mode,
            profile,
            registry[scenario.fixture][mode.id],
          );
          results.push(result);
          groupResults.push(result);
        }
        const group = {
          scenario: scenario.id,
          profile: profile.id,
          classifications: classify(groupResults),
        };
        groups.push(group);
        if (group.classifications.some((label) => label.startsWith("scheduler-"))) {
          await fetch("/counterexample", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ group, results: groupResults }),
          });
        }
      }
    }
  } catch (error) {
    browserErrors.push(errorDetails(error));
  } finally {
    Object.assign(console, originals);
    window.removeEventListener("error", recordError);
    window.removeEventListener("unhandledrejection", recordError);
  }
  const counts = {
    scenarios: scenarios.length,
    profiles: profiles.length,
    modes: modes.length,
    planned: scenarios.length * profiles.length * modes.length,
    executed: results.filter((result) => result.status !== "compile-error").length,
    passed: results.filter((result) => result.status === "pass").length,
    failed: results.filter((result) => result.status === "fail").length,
    compileErrors: results.filter((result) => result.status === "compile-error").length,
    assertions: results.reduce((sum, result) => sum + result.checks, 0),
    committedProbes: results.reduce((sum, result) => sum + result.commits.length, 0),
    schedulerCounterexampleGroups: groups.filter((group) =>
      group.classifications.some((label) => label.startsWith("scheduler-")),
    ).length,
  };
  const report = {
    schemaVersion: 1,
    status:
      counts.passed === counts.planned
      && browserErrors.length === 0
      && consoleMessages.length === 0
      && groups.every(
        (group) => group.classifications.length === 1 && group.classifications[0] === "pass",
      )
        ? "pass"
        : "fail",
    metadata,
    environment: {
      userAgent: navigator.userAgent,
      url: location.href,
      react: reactVersion,
      reactDom: reactDomVersion,
      nodeEnv: "development",
    },
    counts,
    groups,
    results,
    browserErrors,
    consoleMessages,
  };
  window.__schedulingResults = report;
  const json = JSON.stringify(report, null, 2);
  document.getElementById("status").textContent = JSON.stringify(
    { status: report.status, ...counts },
    null,
    2,
  );
  const download = document.getElementById("download");
  download.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  download.hidden = false;
  const response = await fetch("/results", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: json,
  });
  if (!response.ok) throw new Error(`Persisting browser results failed: ${response.status}`);
  return report;
}
