#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadRuntimeConfig } = require('../src/config/runtime-config.cjs');

function instant(value, name) {
  if (
    typeof value !== 'string' ||
    !/(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error(`${name} requires an ISO timestamp with timezone`);
  return Date.parse(value);
}

function canonicalPath(target) {
  let parent = path.resolve(target);
  const missing = [];
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) throw new Error(`Cannot resolve output path: ${target}`);
    missing.unshift(path.basename(parent));
    parent = next;
  }
  return path.join(fs.realpathSync(parent), ...missing);
}

function isWithin(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function exportFilename(number) {
  // These room numbers are valid API keys but reserved as file names on Windows.
  return `${/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(number) ? `room_${number}` : number}.json`;
}

/** SQLite is opened read-only; exported files contain only the five public comment fields. */
function exportComments({ projectRoot, from, to, room, out, env = process.env } = {}) {
  const config = loadRuntimeConfig({ projectRoot, env });
  const begin = from === undefined ? null : instant(from, '--from');
  const end = to === undefined ? null : instant(to, '--to');
  if (begin !== null && end !== null && end <= begin)
    throw new Error('--to must be later than --from');
  const requested =
    room === undefined ? Object.keys(config.rooms) : Array.isArray(room) ? room : [room];
  if (!requested.length) throw new Error('No configured rooms to export');
  if (
    new Set(requested).size !== requested.length ||
    requested.some((number) => !Object.hasOwn(config.rooms, number))
  )
    throw new Error('--room must name distinct configured room numbers');
  const database = path.join(config.dataDir, 'comments.sqlite');
  if (!fs.existsSync(database)) throw new Error(`Comment database does not exist: ${database}`);
  const stamp = new Date(Date.now() + 28800000).toISOString().replace(/[-:.TZ]/g, '');
  const outputDir = canonicalPath(out || path.join(config.outputDir, `comments_${stamp}`));
  for (const protectedDir of [
    config.dataDir,
    path.join(config.root, 'config'),
    path.join(config.root, '.git'),
    path.join(config.root, 'node_modules'),
  ]) {
    if (isWithin(outputDir, canonicalPath(protectedDir)))
      throw new Error(
        'Export directory must be outside data, configuration, Git metadata and dependencies',
      );
  }
  const names = requested.map(exportFilename);
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length)
    throw new Error('Room numbers would produce colliding export file names');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(database, { readOnly: true });
  const exports = [];
  try {
    db.exec('BEGIN');
    for (let i = 0; i < requested.length; i++) {
      const number = requested[i];
      const conditions = ['room_number = ?', 'room_id = ?'];
      const parameters = [number, config.rooms[number].room_id];
      if (begin !== null) {
        conditions.push('received_ms >= ?');
        parameters.push(begin);
      }
      if (end !== null) {
        conditions.push('received_ms < ?');
        parameters.push(end);
      }
      const comments = db
        .prepare(
          `SELECT user_id, user_name, content, comment_id AS id, received_at FROM comments WHERE ${conditions.join(' AND ')} ORDER BY received_ms, CAST(comment_id AS INTEGER)`,
        )
        .all(...parameters);
      const file = path.join(outputDir, names[i]);
      const content = `${JSON.stringify(comments, null, 2)}\n`;
      if (fs.existsSync(file)) {
        if (
          !fs.lstatSync(file).isFile() ||
          fs.lstatSync(file).isSymbolicLink() ||
          fs.readFileSync(file, 'utf8') !== content
        )
          throw new Error(`Refusing to overwrite a different existing export: ${file}`);
      }
      exports.push({
        room_number: number,
        room_id: config.rooms[number].room_id,
        file,
        count: comments.length,
        content,
      });
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  fs.mkdirSync(outputDir, { recursive: true });
  for (const item of exports) {
    if (!fs.existsSync(item.file))
      fs.writeFileSync(item.file, item.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
  return {
    output_dir: outputDir,
    from: from ?? null,
    to: to ?? null,
    total_comments: exports.reduce((total, item) => total + item.count, 0),
    files: exports.map(({ content, ...item }) => item),
  };
}

function parseArguments(argv) {
  const options = {};
  const keys = { '--project-root': 'projectRoot', '--from': 'from', '--to': 'to', '--out': 'out' };
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (option === '--help') return { help: true };
    if ((option !== '--room' && !keys[option]) || !argv[i + 1] || argv[i + 1].startsWith('--'))
      throw new Error(`Unknown or incomplete option: ${option}`);
    const value = argv[++i];
    if (option === '--room') (options.room ||= []).push(value);
    else {
      const key = keys[option];
      if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${option}`);
      options[key] = value;
    }
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(
      'Usage: node scripts/export-comments.cjs [--from ISO] [--to ISO] [--room NUMBER ...] [--out DIRECTORY] [--project-root DIRECTORY]\nExports configured rooms as JSON arrays. The interval includes --from and excludes --to. Repeat --room for multiple rooms. Existing different exports are never overwritten.',
    );
    return;
  }
  console.log(JSON.stringify(exportComments(options), null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { exportComments, parseArguments, exportFilename, main };
