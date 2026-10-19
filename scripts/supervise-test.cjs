#!/usr/bin/env node
'use strict';

// Owns only this project's service child; never operates desktop UI.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadRuntimeConfig } = require('../src/config/runtime-config.cjs');

function parseOptions(argv, now = Date.now()) {
  const options = {};
  const known = {
    '--stop-at': 'stopAt',
    '--rooms': 'roomNumbers',
    '--project-root': 'projectRoot',
  };
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (option === '--help') return { help: true };
    const key = known[option];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--'))
      throw new Error(`Unknown or incomplete option: ${option}`);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${option}`);
    options[key] = argv[++i];
  }
  const deadline = Date.parse(options.stopAt);
  if (
    !options.stopAt ||
    !/(?:Z|[+-]\d\d:\d\d)$/.test(options.stopAt) ||
    !Number.isFinite(deadline) ||
    deadline <= now ||
    deadline - now > 86400000
  )
    throw new Error('--stop-at requires an ISO timestamp with timezone within the next 24 hours');
  if (options.roomNumbers !== undefined) {
    options.roomNumbers = options.roomNumbers.split(',');
    if (
      !options.roomNumbers.length ||
      options.roomNumbers.some((number) => !number) ||
      new Set(options.roomNumbers).size !== options.roomNumbers.length
    )
      throw new Error('--rooms requires distinct comma-separated room numbers');
  }
  return options;
}

function serviceUrl(config) {
  if (!config.port) throw new Error('Supervised tests require a fixed nonzero port');
  const host = ['0.0.0.0', '::', '[::]'].includes(config.host) ? '127.0.0.1' : config.host;
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${config.port}`;
}

async function runSupervisor({ projectRoot, stopAt, roomNumbers, env = process.env }) {
  const config = loadRuntimeConfig({ projectRoot, env });
  const { root, outputDir, dataDir } = config;
  const deadline = Date.parse(stopAt),
    base = serviceUrl(config);
  if (roomNumbers?.some((number) => !Object.hasOwn(config.rooms, number)))
    throw new Error('--rooms contains an unregistered room');
  const logDir = path.join(
    outputDir,
    `supervisor_${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}`,
  );
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = () => new Date(Date.now() + 28800000).toISOString().replace('Z', '+08:00');
  const log = (type, details = {}) =>
    fs.appendFileSync(
      path.join(logDir, 'events.jsonl'),
      `${JSON.stringify({ at: stamp(), type, ...details })}\n`,
    );
  let child,
    stopped = false,
    restarts = 0,
    initialStarted = false;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function call(route, body) {
    const response = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result;
  }
  async function ready(service) {
    for (let tries = 0; tries < 30; tries++) {
      if (service.exitCode !== null || Date.now() >= deadline)
        throw new Error('service exited before readiness or deadline reached');
      try {
        const health = await call('/health');
        if (health.pid !== service.pid) throw new Error('port belongs to a different service');
        return health;
      } catch (error) {
        if (String(error.message).includes('different service')) throw error;
      }
      await sleep(1000);
    }
    throw new Error('service readiness timed out');
  }
  const endTimer = setTimeout(
    () => {
      stopped = true;
      log('planned_shutdown', { deadline: stopAt });
      child?.kill('SIGTERM');
    },
    Math.max(1, deadline - Date.now() + 30000),
  );
  const handleSignal = () => {
    stopped = true;
    child?.kill('SIGTERM');
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
  try {
    while (!stopped && Date.now() < deadline) {
      const stdout = fs.openSync(path.join(logDir, `service_${restarts}_stdout.log`), 'a');
      const stderr = fs.openSync(path.join(logDir, `service_${restarts}_stderr.log`), 'a');
      child = spawn(process.execPath, [path.join(root, 'src/cli.cjs')], {
        cwd: root,
        env,
        windowsHide: true,
        stdio: ['ignore', stdout, stderr],
      });
      fs.closeSync(stdout);
      fs.closeSync(stderr);
      const service = child;
      const exited = new Promise((resolve) => {
        service.once('exit', (code, signal) => resolve({ code, signal }));
        service.once('error', (error) => resolve({ error: error.message }));
      });
      fs.writeFileSync(
        path.join(outputDir, 'supervisor.json'),
        JSON.stringify(
          {
            pid: process.pid,
            child_pid: child.pid,
            log_dir: logDir,
            planned_stop_at: stopAt,
            restarts,
            started_at: stamp(),
          },
          null,
          2,
        ),
      );
      log('service_spawned', { pid: child.pid, restarts });
      try {
        await ready(service);
        if (!initialStarted) {
          const current = await call('/v1/test');
          if (current.phase === 'running') {
            if (Date.parse(current.stop_at) !== deadline)
              throw new Error('another test is already running');
          } else {
            const payload = { stop_at: stopAt };
            if (roomNumbers) payload.room_numbers = roomNumbers;
            await call('/v1/test/start', payload);
          }
          initialStarted = true;
          log('test_authorized', { stop_at: stopAt });
        }
      } catch (error) {
        log('startup_error', { message: error.message });
        if (/another test|different service/.test(error.message)) stopped = true;
        // An owned child may have committed its running marker before readiness failed.
        service.kill('SIGKILL');
      }
      const outcome = await exited;
      log('service_exit', { ...outcome, pid: service.pid });
      if (stopped || Date.now() >= deadline) break;
      const currentFile = path.join(dataDir, 'current_test.json');
      if (initialStarted && fs.existsSync(currentFile)) {
        const current = JSON.parse(fs.readFileSync(currentFile, 'utf8'));
        if (current.phase !== 'running') {
          log('test_not_running_no_restart', { phase: current.phase });
          break;
        }
      }
      restarts++;
      if (restarts > 5) {
        log('restart_limit', { restarts });
        break;
      }
      await sleep(Math.min(30000, restarts * 2000));
    }
    log('supervisor_finished', { restarts });
  } catch (error) {
    log('supervisor_error', { message: error.message });
    child?.kill('SIGTERM');
    throw error;
  } finally {
    clearTimeout(endTimer);
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log(
      'Usage: node scripts/supervise-test.cjs --stop-at ISO [--rooms ROOM1,ROOM2] [--project-root DIRECTORY]\nRuns one supervised test until an absolute deadline within the next 24 hours.',
    );
    return;
  }
  await runSupervisor(options);
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { parseOptions, serviceUrl, runSupervisor, main };
