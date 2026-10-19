'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadRuntimeConfig, roomConfig, readJson } = require('../src/config/runtime-config.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  return root;
}

test('missing local configuration starts with an empty room dictionary and safe defaults without creating files', (t) => {
  const root = fixture(t);
  const config = loadRuntimeConfig({ projectRoot: root, env: {} });
  assert.deepEqual(config.rooms, {});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8789);
  assert.equal(config.dataDir, path.join(root, 'data'));
  assert.equal(config.settings.retention_hours, 48);
  assert.equal(config.settings.raw_frames, false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'config')), []);
});

test('local configuration overrides examples and preserves long platform IDs as strings', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'config/rooms.example.json'), '{ invalid example');
  fs.writeFileSync(
    path.join(root, 'config/rooms.json'),
    JSON.stringify({ shop: { room_id: '123456789012345678', enabled: false } }),
  );
  fs.writeFileSync(
    path.join(root, 'config/settings.json'),
    JSON.stringify({ port: 12345, data_dir: 'runtime/cache' }),
  );
  const config = loadRuntimeConfig({ projectRoot: root, env: {} });
  assert.equal(config.port, 12345);
  assert.equal(config.rooms.shop.room_id, '123456789012345678');
  assert.equal(config.rooms.shop.enabled, false);
  assert.equal(config.dataDir, path.join(root, 'runtime/cache'));
  assert.equal(config.roomsFile, path.join(root, 'config/rooms.json'));
});

test('environment variables override host, port and runtime directories while port zero remains valid for tests', (t) => {
  const root = fixture(t);
  const config = loadRuntimeConfig({
    projectRoot: root,
    settings: { port: 8789 },
    rooms: {},
    env: {
      HOST: '::1',
      PORT: '0',
      DATA_DIR: 'runtime-data',
      OUTPUT_DIR: path.join(root, 'reports'),
    },
  });
  assert.equal(config.host, '::1');
  assert.equal(config.port, 0);
  assert.equal(config.settings.port, 0);
  assert.equal(config.dataDir, path.join(root, 'runtime-data'));
  assert.equal(config.outputDir, path.join(root, 'reports'));
});

test('invalid settings are rejected before service startup', (t) => {
  const root = fixture(t);
  for (const settings of [
    { port: 65536 },
    { port: -1 },
    { port: 1.5 },
    { port: '' },
    { retention_hours: 0 },
    { retention_hours: '48' },
    { preroll_seconds: -1 },
    { resume_active_test: 'true' },
    { raw_frames: 1 },
    { data_dir: '' },
    { host: '' },
  ]) {
    assert.throws(() => loadRuntimeConfig({ projectRoot: root, settings, rooms: {}, env: {} }));
  }
  assert.throws(
    () => loadRuntimeConfig({ projectRoot: root, settings: {}, rooms: [], env: {} }),
    /JSON object/,
  );
});

test('room URLs must match a string ID and room switches must be booleans', () => {
  assert.throws(() => roomConfig('shop', { room_id: 123 }));
  assert.throws(() => roomConfig('../shop', { room_id: '123' }));
  assert.throws(() =>
    roomConfig('shop', { room_id: '123', url: 'https://www.xiaohongshu.com/livestream/124' }),
  );
  assert.throws(() => roomConfig('shop', { room_id: '123', enabled: 'false' }), /boolean/);
  assert.equal(roomConfig('shop', { room_id: '123' }).enabled, true);
});

test('malformed configuration reports its file path instead of silently using defaults', (t) => {
  const root = fixture(t),
    file = path.join(root, 'config/settings.json');
  fs.writeFileSync(file, 'broken');
  assert.throws(
    () => readJson(file, {}),
    (error) => error.message.includes(file),
  );
  assert.throws(
    () => loadRuntimeConfig({ projectRoot: root, env: {} }),
    /Unable to read JSON configuration/,
  );
});
