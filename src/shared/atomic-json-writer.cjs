const fs = require('node:fs');

// Windows readers can briefly deny rename even when writing a temp file works.
// Serialize per destination, retry asynchronously and coalesce newer snapshots.
function createAtomicJsonWriter({
  io = fs.promises,
  onRetry = () => {},
  onError = () => {},
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retryDelays = [50, 100, 200, 400, 800, 1000, 1000],
} = {}) {
  const entries = new Map();
  const failures = new Map();
  function report(callback, ...args) {
    try {
      callback(...args);
    } catch {}
  }
  async function drain(file, entry) {
    while (entry.pending !== null) {
      const raw = entry.pending;
      entry.pending = null;
      const tmp = file + '.' + process.pid + '.tmp';
      try {
        await io.writeFile(tmp, raw);
        let retry = 0;
        for (;;) {
          try {
            await io.rename(tmp, file);
            break;
          } catch (error) {
            if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || retry >= retryDelays.length)
              throw error;
            report(onRetry, file, error, retry + 1);
            await delay(retryDelays[retry++]);
          }
        }
        failures.delete(file);
      } catch (error) {
        failures.set(file, error);
        report(onError, file, error);
      }
    }
  }
  function save(file, value) {
    let entry = entries.get(file);
    if (!entry) {
      entry = { pending: null, running: null };
      entries.set(file, entry);
    }
    entry.pending = JSON.stringify(value, null, 2);
    if (!entry.running) start(file, entry);
  }
  function start(file, entry) {
    entry.running = drain(file, entry).finally(() => {
      entry.running = null;
      if (entry.pending !== null) start(file, entry);
    });
  }
  async function flush() {
    while ([...entries.values()].some((entry) => entry.running))
      await Promise.all([...entries.values()].map((entry) => entry.running).filter(Boolean));
    return {
      ok: failures.size === 0,
      failures: [...failures].map(([file, error]) => ({
        file,
        code: error.code,
        message: error.message,
      })),
    };
  }
  return { save, flush };
}
module.exports = { createAtomicJsonWriter };
