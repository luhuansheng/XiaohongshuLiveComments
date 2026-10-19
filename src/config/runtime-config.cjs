'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SETTINGS = Object.freeze({
  host: '127.0.0.1',
  port: 8789,
  data_dir: 'data',
  output_dir: 'outputs',
  retention_hours: 48,
  preroll_seconds: 300,
  resume_active_test: true,
  raw_frames: false,
});

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read JSON configuration ${file}: ${error.message}`, {
      cause: error,
    });
  }
}

function roomConfig(number, value) {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(number) || ['.', '..'].includes(number))
    throw new Error('invalid room_number');
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.room_id !== 'string' ||
    !/^\d+$/.test(value.room_id)
  )
    throw new Error('room_id must be a numeric string');
  const url = new URL(value.url || `https://www.xiaohongshu.com/livestream/${value.room_id}`);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.xiaohongshu.com' ||
    url.pathname !== `/livestream/${value.room_id}` ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('invalid public livestream URL');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    throw new Error('enabled must be a boolean');
  return { room_id: value.room_id, url: url.href, enabled: value.enabled !== false };
}

function plainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${name} must be a JSON object`);
  return value;
}

function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
    throw new TypeError(`${name} must be a nonempty string`);
  return value;
}

/** Read-only loading: first startup works without local configuration files. */
function loadRuntimeConfig({
  projectRoot = path.resolve(__dirname, '../..'),
  settings,
  rooms,
  env = process.env,
} = {}) {
  const root = path.resolve(projectRoot);
  const configDir = path.join(root, 'config');
  const roomsFile = path.join(configDir, 'rooms.json');
  const settingsFile = path.join(configDir, 'settings.json');
  const loadedSettings =
    settings ??
    (fs.existsSync(settingsFile)
      ? readJson(settingsFile)
      : readJson(path.join(configDir, 'settings.example.json'), {}));
  const resultSettings = { ...DEFAULT_SETTINGS, ...plainObject(loadedSettings, 'settings') };
  resultSettings.host = text(env.HOST ?? resultSettings.host, 'host');
  const portValue = env.PORT ?? resultSettings.port;
  if (
    (typeof portValue !== 'number' && typeof portValue !== 'string') ||
    (typeof portValue === 'string' && !/^\d+$/.test(portValue))
  )
    throw new TypeError('port must be an integer from 0 to 65535');
  resultSettings.port = Number(portValue);
  if (
    !Number.isInteger(resultSettings.port) ||
    resultSettings.port < 0 ||
    resultSettings.port > 65535
  )
    throw new TypeError('port must be an integer from 0 to 65535');
  resultSettings.data_dir = text(env.DATA_DIR ?? resultSettings.data_dir, 'data_dir');
  resultSettings.output_dir = text(env.OUTPUT_DIR ?? resultSettings.output_dir, 'output_dir');
  if (!Number.isFinite(resultSettings.retention_hours) || resultSettings.retention_hours <= 0)
    throw new TypeError('retention_hours must be positive');
  if (!Number.isFinite(resultSettings.preroll_seconds) || resultSettings.preroll_seconds < 0)
    throw new TypeError('preroll_seconds must be nonnegative');
  for (const field of ['resume_active_test', 'raw_frames'])
    if (typeof resultSettings[field] !== 'boolean')
      throw new TypeError(`${field} must be a boolean`);
  const loadedRooms =
    rooms ??
    (fs.existsSync(roomsFile)
      ? readJson(roomsFile)
      : readJson(path.join(configDir, 'rooms.example.json'), {}));
  const resultRooms = Object.fromEntries(
    Object.entries(plainObject(loadedRooms, 'rooms')).map(([number, value]) => [
      number,
      roomConfig(number, value),
    ]),
  );
  return {
    root,
    settings: resultSettings,
    rooms: resultRooms,
    roomsFile,
    dataDir: path.resolve(root, resultSettings.data_dir),
    outputDir: path.resolve(root, resultSettings.output_dir),
    host: resultSettings.host,
    port: resultSettings.port,
  };
}

module.exports = { DEFAULT_SETTINGS, loadRuntimeConfig, roomConfig, readJson };
