export type RestoreEnvironment = () => void;

/**
 * Sets one process-wide environment variable and hands back the undo.
 *
 * Vitest gives each test file its own worker but not its own process
 * environment, so a variable left behind here is one every later test in the
 * file inherits without asking for it. Returning the restore rather than
 * remembering it somewhere keeps the undo next to the change.
 */
export function withEnvironmentVariable(name: string, value: string): RestoreEnvironment {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  };
}
