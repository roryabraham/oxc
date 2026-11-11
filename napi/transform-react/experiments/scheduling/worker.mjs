import { errorRecord } from "./oracles.mjs";
import { loadBinding, runTask, versions } from "./runtime.mjs";

let binding;
let noMemo = false;
let busy = false;
process.on("message", async (message) => {
  if (busy) throw new Error("Worker received concurrent jobs");
  busy = true;
  try {
    if (message.type === "initialize") {
      const loaded = message.sourceOnly ? null : await loadBinding(message.binding);
      binding = loaded?.binding;
      noMemo = Boolean(message.noMemo);
      process.send({ type: "ready", metadata: loaded?.metadata ?? null, versions: versions() });
    } else if (message.type === "task") {
      const result = await runTask(
        message.task,
        binding,
        (progress) => process.send({ type: "progress", task: message.task.id, progress }),
        noMemo,
      );
      process.send({ type: "result", result });
    }
  } catch (error) {
    process.send({ type: "error", error: errorRecord(error) });
  } finally {
    busy = false;
  }
});
