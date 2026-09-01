// The signal contract both long-running processes follow: finish what is in
// flight, then exit 0. A container runtime sends SIGTERM and waits; a terminal
// sends SIGINT. Anything already stopping ignores a second signal rather than
// racing itself, and a shutdown that throws exits nonzero so a supervisor can
// tell a clean stop from a stuck one.
export function shutdownOn(signals, stop) {
  let stopping = false;
  for (const signal of signals) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      stop().then(
        () => {
          process.exit(0);
        },
        (error) => {
          process.stderr.write(
            `shutdown: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exit(1);
        },
      );
    });
  }
}
