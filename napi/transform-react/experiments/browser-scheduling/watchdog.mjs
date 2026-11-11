export class BrowserWatchdog {
  activeCell = null;
  lastCell = null;
  completed = [];
  phase = "waiting-for-browser";
  stopped = false;
  totalTimer = null;
  cellTimer = null;

  constructor({ totalMs, cellMs, onTimeout }) {
    this.totalMs = totalMs;
    this.cellMs = cellMs;
    this.onTimeout = onTimeout;
  }

  start() {
    this.totalTimer = setTimeout(() => this.expire("browser-total", this.totalMs), this.totalMs);
  }

  begin(cell) {
    if (this.stopped || this.activeCell) {
      throw new Error("Unexpected overlapping or late browser cell");
    }
    this.phase = "running-cell";
    this.activeCell = cell;
    this.lastCell = cell;
    this.cellTimer = setTimeout(() => this.expire("browser-cell", this.cellMs), this.cellMs);
  }

  complete(result) {
    if (
      this.stopped
      || !this.activeCell
      || ["scenario", "fixture", "profile", "mode"].some(
        (key) => this.activeCell[key] !== result[key],
      )
    ) {
      throw new Error("Browser result does not match the active cell");
    }
    clearTimeout(this.cellTimer);
    this.activeCell = null;
    this.completed.push(result);
    this.phase = "between-cells";
  }

  snapshot() {
    return {
      phase: this.phase,
      activeCell: this.activeCell,
      lastCell: this.lastCell,
      completedCells: this.completed.length,
    };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.totalTimer);
    clearTimeout(this.cellTimer);
  }

  expire(deadline, timeoutMs) {
    if (this.stopped) return;
    this.stop();
    Promise.resolve(
      this.onTimeout({ status: "timeout", deadline, timeoutMs, ...this.snapshot() }),
    ).catch((error) => {
      process.stderr.write(`Watchdog persistence failed: ${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
  }
}
