type LogContext = Record<string, boolean | number | string | null | undefined>;

function errorDetails(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "UnknownError", message: String(error) };
}

export function logServerError(event: string, error: unknown, context: LogContext = {}): void {
  console.error("[stash-server]", {
    level: "error",
    event,
    ...context,
    error: errorDetails(error),
  });
}

export function logServerWarning(event: string, context: LogContext = {}): void {
  console.warn("[stash-server]", { level: "warn", event, ...context });
}
