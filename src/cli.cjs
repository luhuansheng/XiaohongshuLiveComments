'use strict';

const { CollectorService } = require('./application/collector-service.cjs');
const { beijingTime } = require('./shared/time.cjs');

/** The CLI alone owns process signals, exits, and supervisor restart codes. */
async function runCli() {
  const service = new CollectorService({
    restartHandler: async (runningService) => {
      try {
        await runningService.close('fatal');
        process.exit(75);
      } catch (error) {
        console.error(error.message);
        process.exit(1);
      }
    },
  });
  let closing = false;
  const close = async (reason) => {
    if (closing) return;
    closing = true;
    try {
      await service.close(reason);
    } catch (error) {
      console.error(error.message);
    }
    process.exit(reason === 'fatal' ? 1 : 0);
  };

  process.on('SIGINT', () => close('SIGINT'));
  process.on('SIGTERM', () => close('SIGTERM'));
  process.on('uncaughtException', (error) => {
    console.error(error.stack);
    service.log('fatal', { message: error.message });
    setTimeout(() => process.exit(1), 10000).unref();
    close('fatal');
  });

  await service.listen();
  console.log(
    JSON.stringify({
      started_at: beijingTime(),
      pid: process.pid,
      host: service.host,
      port: service.port,
    }),
  );
  return service;
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error.stack);
    process.exit(1);
  });
}

module.exports = { runCli };
