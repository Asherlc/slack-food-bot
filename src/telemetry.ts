export type ExceptionContext = Readonly<Record<string, string>>;
export type ExceptionSink = (error: unknown, context?: ExceptionContext) => void;

export interface ExceptionReporter {
  captureException(error: unknown, context?: ExceptionContext): void;
}

export function createExceptionReporter(
  sink: ExceptionSink = (error, context) => {
    console.error("Unexpected error", { error, ...context });
  },
): ExceptionReporter {
  return {
    captureException(error, context) {
      sink(error, context);
    },
  };
}
