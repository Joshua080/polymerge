/**
 * A hung browser call must fail an end-to-end script loudly and quickly, naming where it hung —
 * not stall CI until the job timeout. Call `mark(step)` before each stage; `onTimeout` cleans up
 * (e.g. kills the CLI server the script spawned) before the process exits.
 */
export function watchdog(name, ms) {
  let step = 'start';
  let since = Date.now();
  const cleanups = [];
  const timer = setTimeout(() => {
    console.error(`${name}: FAIL — no result within ${ms} ms; stuck in "${step}" for ${Date.now() - since} ms`);
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        // best effort
      }
    }
    process.exit(1);
  }, ms);
  timer.unref();
  return {
    mark(next) {
      step = next;
      since = Date.now();
    },
    onTimeout(fn) {
      cleanups.push(fn);
    },
  };
}
