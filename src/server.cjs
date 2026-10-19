'use strict';

// Compatibility entry for existing supervisor commands and library consumers.
const { CollectorService } = require('./application/collector-service.cjs');
const { roomConfig } = require('./config/runtime-config.cjs');
const { instant } = require('./shared/time.cjs');

if (require.main === module) {
  require('./cli.cjs')
    .runCli()
    .catch((error) => {
      console.error(error.stack);
      process.exit(1);
    });
}

module.exports = { CollectorService, roomConfig, instant };
