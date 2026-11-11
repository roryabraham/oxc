import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { NativeCompiler } from "../native-client.mjs";

const { values } = parseArgs({ options: { binding: { type: "string" }, output: { type: "string" } } });
if (!values.binding || !values.output) throw new Error("--binding and --output are required");
const output = path.resolve(values.output);
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error("--output must be empty");
const wrapper = path.join(output, "blocked-binding.mjs");
await writeFile(wrapper, `export { __napiBindingTarget } from ${JSON.stringify(pathToFileURL(path.resolve(values.binding)).href)};
export function transformSync() { while (true) {} }\n`);

const compiler = new NativeCompiler(wrapper, 10000);
let observed;
try {
  await compiler.ready;
  compiler.timeoutMs = 100;
  try {
    await compiler.transform("blocked-native-control", "U", "export function Component() { return null; }", {
      lang: "jsx", sourceType: "module", jsx: "preserve", reactCompiler: false,
    });
    assert.fail("A synchronous worker loop must not return successfully");
  } catch (error) {
    observed = { name: error.name, message: error.message, details: error.details };
    assert.equal(error.name, "NativeCompilationTimeout");
    assert.equal(error.details.fixture, "blocked-native-control");
    assert.equal(error.details.mode, "U");
    assert.equal(error.details.native.binarySha256, compiler.native.binarySha256);
    assert.equal(error.details.timeoutMs, 100);
  }
} finally {
  await compiler.stop();
}
assert.equal(compiler.child.signalCode, "SIGKILL");
const report = { status: "pass", control: "synchronous-native-worker-hang", observed, workerSignal: compiler.child.signalCode, compiledCode: null };
await writeFile(path.join(output, "control-result.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: report.status, control: report.control, native: compiler.native.binarySha256, workerSignal: report.workerSignal })}\n`);
