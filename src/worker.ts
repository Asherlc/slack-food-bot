import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createWorkerRuntime } from "./runtime.js";
import { createExceptionReporter } from "./telemetry.js";

export function startWorker(env: NodeJS.ProcessEnv = process.env) {
  return createWorkerRuntime(loadConfig(env));
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  try {
    startWorker();
  } catch (error: unknown) {
    createExceptionReporter().captureException(error, { operation: "worker-startup" });
    process.exitCode = 1;
  }
}
