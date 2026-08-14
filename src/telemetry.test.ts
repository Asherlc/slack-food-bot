import { describe, expect, it, vi } from "vitest";
import { createExceptionReporter } from "./telemetry.js";

describe("createExceptionReporter", () => {
  it("forwards unexpected exceptions to the injected reporter", () => {
    const report = vi.fn();
    const reporter = createExceptionReporter(report);
    const error = new Error("unexpected");

    reporter.captureException(error, { operation: "health" });

    expect(report).toHaveBeenCalledWith(error, { operation: "health" });
  });
});
