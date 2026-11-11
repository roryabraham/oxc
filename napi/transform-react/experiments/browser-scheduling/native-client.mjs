import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

export class NativeCompiler {
  nextId = 0;
  pending = null;
  native = null;
  failed = false;
  stderr = "";
  stdout = "";

  constructor(binding, timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.child = fork(fileURLToPath(new URL("./native-worker.mjs", import.meta.url)), [binding], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: [],
    });
    this.child.stdout.on("data", (chunk) => {
      this.stdout = (this.stdout + chunk).slice(-65536);
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-65536);
    });
    this.child.on("error", (error) => this.fail(error.message));
    this.child.on("exit", (code, signal) => {
      if (this.pending) this.fail(`Native worker exited: code=${code}, signal=${signal}`);
    });
    this.child.on("message", (message) => {
      if (!this.pending) return;
      if (message.type === "load-error") {
        this.fail(message.error.message);
      } else if (message.type === "ready" && this.pending.context.stage === "native-load") {
        this.native = message.native;
        this.finish(message.native);
      } else if (message.type === "result" && message.id === this.pending.id) {
        this.finish(message.result);
      } else {
        this.fail("Unexpected native worker response");
      }
    });
    this.ready = this.wait({ stage: "native-load", binding });
  }

  wait(context) {
    if (this.pending || this.failed) throw new Error("Native worker is busy or unavailable");
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(
        () => this.fail(`Native process deadline exceeded (${this.timeoutMs} ms)`, true),
        this.timeoutMs,
      );
      this.pending = { id, context, timer, resolve, reject };
    });
  }

  finish(value) {
    const { timer, resolve } = this.pending;
    this.pending = null;
    clearTimeout(timer);
    resolve(value);
  }

  fail(message, timedOut = false) {
    this.failed = true;
    if (this.pending) {
      const { timer, reject, context } = this.pending;
      this.pending = null;
      clearTimeout(timer);
      const error = new Error(message);
      error.name = timedOut ? "NativeCompilationTimeout" : "NativeWorkerFailure";
      error.details = {
        ...context,
        native: this.native,
        timeoutMs: this.timeoutMs,
        pid: this.child.pid,
        stdout: this.stdout,
        stderr: this.stderr,
      };
      reject(error);
    }
    this.child.kill("SIGKILL");
  }

  async transform(fixture, mode, source, options) {
    await this.ready;
    const result = this.wait({ stage: "native-compile", fixture, mode, source, options });
    this.child.send({ id: this.pending.id, filename: `${fixture}.jsx`, source, options });
    return result;
  }

  async stop() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise((resolve) => {
      this.child.once("exit", resolve);
      this.child.kill("SIGKILL");
    });
  }
}
