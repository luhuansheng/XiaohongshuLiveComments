#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_SETTINGS, readJson } = require('../src/config/runtime-config.cjs');

function initializeConfig(projectRoot = path.resolve(__dirname, '..')) {
  const configDir = path.join(path.resolve(projectRoot), 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const created = [],
    preserved = [];
  for (const [name, fallback] of [
    ['settings', DEFAULT_SETTINGS],
    ['rooms', {}],
  ]) {
    const target = path.join(configDir, `${name}.json`);
    if (fs.existsSync(target)) {
      preserved.push(target);
      continue;
    }
    const content = readJson(path.join(configDir, `${name}.example.json`), fallback);
    try {
      fs.writeFileSync(target, `${JSON.stringify(content, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      created.push(target);
    } catch (error) {
      if (error.code === 'EEXIST') preserved.push(target);
      else throw error;
    }
  }
  return { created, preserved };
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log(
      'Usage: node scripts/init-config.cjs [--project-root DIRECTORY]\nCreates only missing local configuration files; existing files are preserved.',
    );
    return;
  }
  let projectRoot;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--project-root' || !argv[i + 1])
      throw new Error(`Unknown or incomplete option: ${argv[i]}`);
    projectRoot = argv[++i];
  }
  console.log(JSON.stringify(initializeConfig(projectRoot), null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { initializeConfig, main };
