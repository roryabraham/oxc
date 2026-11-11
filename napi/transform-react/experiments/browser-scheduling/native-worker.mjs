import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function hashFile(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

function errorDetails(error) {
  return { name: error?.name, message: error?.message ?? String(error), stack: error?.stack };
}

async function loadBinding(filename) {
  for (const variable of [
    "NAPI_RS_NATIVE_LIBRARY_PATH",
    "NAPI_RS_FORCE_WASI",
    "NAPI_RS_WASI_FLAVOR",
  ]) {
    if (process.env[variable]) {
      throw new Error(`Unset ${variable}; --binding must identify the actual native artifact`);
    }
  }
  const loader = await realpath(path.resolve(filename));
  const before = new Set(process.report.getReport().sharedObjects);
  const binding = await import(pathToFileURL(loader).href);
  if (binding.__napiBindingTarget !== "native" || typeof binding.transformSync !== "function") {
    throw new Error("The supplied loader must export a native transformSync binding");
  }
  const loaded = process.report
    .getReport()
    .sharedObjects.filter((file) => file.endsWith(".node") && !before.has(file));
  if (loaded.length !== 1) {
    throw new Error(
      `Expected exactly one newly loaded native addon, got ${JSON.stringify(loaded)}`,
    );
  }
  const binary = await realpath(loaded[0]);
  const native = {
    loader,
    loaderSha256: await hashFile(loader),
    target: binding.__napiBindingTarget,
    binary,
    binarySha256: await hashFile(binary),
  };
  try {
    native.buildMetadata = JSON.parse(
      await readFile(path.join(path.dirname(loader), "build-metadata.json"), "utf8"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (
    native.buildMetadata?.binarySha256
    && native.buildMetadata.binarySha256 !== native.binarySha256
  ) {
    throw new Error("Loaded binary hash differs from adjacent build-metadata.json");
  }
  return { binding, native };
}

process.on("disconnect", () => process.exit(0));
try {
  const { binding, native } = await loadBinding(process.argv[2]);
  process.send({ type: "ready", native });
  process.on("message", ({ id, filename, source, options }) => {
    let result;
    try {
      result = binding.transformSync(filename, source, options);
    } catch (error) {
      result = { fatal: true, code: "", errors: [errorDetails(error)] };
    }
    process.send({ type: "result", id, result });
  });
} catch (error) {
  process.send({ type: "load-error", error: errorDetails(error) });
  process.exitCode = 1;
  process.disconnect();
}
