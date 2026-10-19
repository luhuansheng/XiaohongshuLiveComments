'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { initializeConfig } = require('../scripts/init-config.cjs');
const { exportComments, parseArguments } = require('../scripts/export-comments.cjs');
const { parseOptions, serviceUrl } = require('../scripts/supervise-test.cjs');
const { CommentStore } = require('../src/infrastructure/storage/comment-store.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-operations-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  return root;
}

function databaseFixture(t) {
  const root = fixture(t),
    dataDir = path.join(root, 'data');
  fs.writeFileSync(
    path.join(root, 'config/rooms.json'),
    JSON.stringify({ shop: { room_id: '123' }, empty: { room_id: '456' } }),
  );
  const at = Date.parse('2026-10-14T12:00:00+08:00');
  const store = new CommentStore({ dataDir, now: () => at });
  store.registerRoom({ room_number: 'shop', room_id: '123' });
  store.registerRoom({ room_number: 'empty', room_id: '456' });
  const event = {
    room_number: 'shop',
    room_id: '123',
    user_id: '9876543210123456789',
    user_name: '示例用户',
    content: '测试评论',
    received_at: at,
  };
  const first = store.append({ ...event, upstream_id: 'one' }).comment;
  store.append({ ...event, upstream_id: 'two', received_at: at + 60000 });
  store.append({
    ...event,
    room_id: '789',
    upstream_id: 'historical-room',
    received_at: at + 10000,
  });
  store.close();
  return { root, dataDir, first };
}

test('configuration initialization creates missing files and never overwrites local settings', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'config/settings.example.json'), JSON.stringify({ port: 8789 }));
  const target = path.join(root, 'config/settings.json'),
    local = '{"port": 9000}\n';
  fs.writeFileSync(target, local);
  const result = initializeConfig(root);
  assert.deepEqual(result.created, [path.join(root, 'config/rooms.json')]);
  assert.deepEqual(result.preserved, [target]);
  assert.equal(fs.readFileSync(target, 'utf8'), local);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.created[0], 'utf8')), {});
  assert.equal(initializeConfig(root).created.length, 0);
});

test('read-only exports preserve public fields, string IDs, room separation and empty arrays', (t) => {
  const { root, dataDir, first } = databaseFixture(t);
  const database = path.join(dataDir, 'comments.sqlite');
  const digest = () => createHash('sha256').update(fs.readFileSync(database)).digest('hex');
  const before = digest(),
    out = path.join(root, 'exports');
  const result = exportComments({ projectRoot: root, out, env: {} });
  assert.equal(result.total_comments, 2);
  const comments = JSON.parse(fs.readFileSync(path.join(out, 'shop.json'), 'utf8'));
  assert.deepEqual(comments[0], first);
  assert.equal(comments.length, 2);
  assert.deepEqual(Object.keys(comments[0]), [
    'user_id',
    'user_name',
    'content',
    'id',
    'received_at',
  ]);
  assert.ok(comments.every((comment) => comment.received_at.endsWith('+08:00')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'empty.json'), 'utf8')), []);
  assert.equal(digest(), before);
  assert.equal(exportComments({ projectRoot: root, out, env: {} }).total_comments, 2);
});

test('export time filters include the start and exclude the end', (t) => {
  const { root, first } = databaseFixture(t);
  const result = exportComments({
    projectRoot: root,
    room: ['shop'],
    from: '2026-10-14T12:00:00+08:00',
    to: '2026-10-14T12:01:00+08:00',
    out: path.join(root, 'window'),
    env: {},
  });
  assert.equal(result.files.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.files[0].file, 'utf8')), [first]);
  assert.throws(
    () => exportComments({ projectRoot: root, from: '2026-10-14T12:00:00', env: {} }),
    /timezone/,
  );
  assert.throws(
    () =>
      exportComments({
        projectRoot: root,
        from: '2026-10-14T12:00:00Z',
        to: '2026-10-14T12:00:00Z',
        env: {},
      }),
    /later/,
  );
});

test('export cannot overwrite different output or write into data/configuration', (t) => {
  const { root, dataDir } = databaseFixture(t),
    out = path.join(root, 'existing');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'shop.json'), '["keep"]\n');
  assert.throws(() => exportComments({ projectRoot: root, out, env: {} }), /Refusing to overwrite/);
  assert.equal(fs.readFileSync(path.join(out, 'shop.json'), 'utf8'), '["keep"]\n');
  assert.ok(!fs.existsSync(path.join(out, 'empty.json')));
  for (const forbidden of [
    dataDir,
    path.join(dataDir, 'exports'),
    path.join(root, 'config/export'),
  ])
    assert.throws(() => exportComments({ projectRoot: root, out: forbidden, env: {} }), /outside/);
  assert.throws(
    () => exportComments({ projectRoot: root, room: ['unknown'], env: {} }),
    /configured/,
  );
});

test('operation CLI parsers reject incomplete/duplicate options without starting a live test', () => {
  assert.deepEqual(parseArguments(['--room', 'shop', '--room', 'empty', '--out', 'export']), {
    room: ['shop', 'empty'],
    out: 'export',
  });
  assert.throws(() => parseArguments(['--out', 'a', '--out', 'b']), /Duplicate/);
  assert.throws(() => parseArguments(['--from']), /incomplete/);
  const now = Date.parse('2026-10-14T10:00:00+08:00');
  assert.deepEqual(
    parseOptions(['--stop-at', '2026-10-14T17:00:00+08:00', '--rooms', 'shop,empty'], now),
    { stopAt: '2026-10-14T17:00:00+08:00', roomNumbers: ['shop', 'empty'] },
  );
  assert.throws(
    () => parseOptions(['--stop-at', '2026-10-14T09:00:00+08:00'], now),
    /next 24 hours/,
  );
  assert.throws(
    () => parseOptions(['--stop-at', '2026-10-14T17:00:00+08:00', '--rooms', 'shop,shop'], now),
    /distinct/,
  );
  assert.equal(serviceUrl({ host: '0.0.0.0', port: 8789 }), 'http://127.0.0.1:8789');
  assert.equal(serviceUrl({ host: '::1', port: 8789 }), 'http://[::1]:8789');
  assert.throws(() => serviceUrl({ host: '127.0.0.1', port: 0 }), /nonzero/);
});
