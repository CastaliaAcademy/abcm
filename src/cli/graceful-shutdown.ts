export function installGracefulShutdown(close: () => Promise<void>): void {
  let closing: Promise<void> | undefined;
  const shutdown = () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    closing ??= close().catch(error => {
      console.error("ABCM graceful shutdown failed:", error);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
