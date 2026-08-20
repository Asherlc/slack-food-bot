import { type Environment, loadConfig } from "./config.js";
import { handleHealthRequest } from "./http/health-handler.js";
import { createExceptionReporter } from "./telemetry.js";

const worker = {
  fetch(request: Request, env: Environment): Response {
    try {
      loadConfig(env);
      return handleHealthRequest(request);
    } catch (error: unknown) {
      createExceptionReporter().captureException(error, { operation: "worker-request" });
      return Response.json(
        { error: "Internal Server Error" },
        { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
  },
};

export default worker;
