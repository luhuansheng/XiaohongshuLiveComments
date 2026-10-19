'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CollectorService } = require('../src/application/collector-service.cjs');
const { createRequestHandler } = require('../src/http/router.cjs');

test('public and compatibility imports never start a server or register process handlers', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
      const fs = require('node:fs');
      const http = require('node:http');
      const reject = () => { throw new Error('library import must be inert'); };
      fs.mkdirSync = fs.writeFileSync = fs.appendFileSync = reject;
      http.Server.prototype.listen = reject;
      const on = process.on.bind(process);
      process.on = (event, callback) => {
        if (['SIGINT', 'SIGTERM', 'uncaughtException'].includes(event)) reject();
        return on(event, callback);
      };
      const library = require('./src/index.cjs');
      const compatibility = require('./src/server.cjs');
      require('./src/cli.cjs');
      if (compatibility.CollectorService !== library.CollectorService) reject();
      if (compatibility.roomConfig !== library.roomConfig) reject();
      if (compatibility.instant !== library.instant) reject();
      process.stdout.write('inert');
      `,
    ],
    { cwd: projectRoot, encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'inert');
});

async function routerFixture(t, service) {
  const server = http.createServer(createRequestHandler(service));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return async (route, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return { status: response.status, body: await response.json() };
  };
}

test('HTTP restart delegates to the injected lifecycle handler without exiting the importing process', async (t) => {
  let restarts = 0;
  const service = Object.create(CollectorService.prototype);
  service.activeTest = { phase: 'running' };
  service.log = () => {};
  const call = await routerFixture(t, service);

  const unavailable = await call('/v1/service/restart', 'POST');
  assert.equal(unavailable.status, 400);
  assert.match(unavailable.body.error, /supervised CLI/);

  service.restartHandler = async (sameService) => {
    assert.equal(sameService, service);
    restarts++;
  };
  const accepted = await call('/v1/service/restart', 'POST');
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.preserves_test, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restarts, 1);

  service.activeTest.phase = 'completed';
  assert.equal((await call('/v1/service/restart', 'POST')).status, 400);
  assert.equal(restarts, 1);
});

test('extracted HTTP router preserves validation and unsupported-route responses', async (t) => {
  const service = {
    rooms: { example: { room_id: '123' } },
    startTest: async (body) => body,
  };
  const call = await routerFixture(t, service);
  assert.equal((await call('/unknown')).status, 404);
  assert.equal((await call('/v1/rooms/missing')).body.error, 'unknown_room');
  assert.equal((await call('/v1/rooms/example')).status, 405);
  assert.equal((await call('/v1/test/start', 'POST', '{')).status, 400);
  const valid = await call('/v1/test/start', 'POST', '{"stop_at":"example"}');
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.body, { stop_at: 'example' });
});
