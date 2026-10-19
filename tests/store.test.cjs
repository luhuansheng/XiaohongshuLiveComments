'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CommentStore } = require('../src/infrastructure/storage/comment-store.cjs');

function temporaryStore(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-commentstore-test-'));
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}xhs-commentstore-test-`));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  function open() {
    const store = new CommentStore({ dataDir: directory, ...options });
    stores.push(store);
    return store;
  }
  return { directory, open, store: open() };
}

function input(upstreamId, time, extras = {}) {
  return {
    room_number: 'shop_01',
    room_id: '123456789012345678',
    upstream_id: upstreamId,
    user_id: '9876543210123456789',
    user_name: '示例用户',
    content: '示例评论',
    received_at: time,
    ...extras,
  };
}

function jsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? jsonFiles(target) : entry.name.endsWith('.json') ? [target] : [];
  });
}

test('registered rooms expose their ID before receiving any comment', (t) => {
  const at = Date.parse('2026-10-14T12:00:00+08:00');
  const { store, open } = temporaryStore(t, { now: () => at });
  assert.deepEqual(store.registerRoom({ room_number: 'shop_01', room_id: '123456789012345678' }), {
    count: 0,
    current_room_id: '123456789012345678',
    first_received_at: null,
    last_received_at: null,
  });
  assert.equal(store.query('shop_01').room_id, '123456789012345678');
  assert.equal(
    store.window('shop_01', { start: at - 1000, end: at }).room_id,
    '123456789012345678',
  );
  const first = store.append(input('first', at));
  store.close();
  const reopened = open();
  reopened.registerRoom({ room_number: 'shop_01', room_id: '123456789012345678' });
  assert.equal(
    reopened.append(input('second', at)).comment.id,
    String(Number(first.comment.id) + 1),
  );
});

test('deduplication preserves exported ID and Beijing time across reopening', (t) => {
  const at = Date.parse('2026-10-14T12:00:00.123+08:00');
  const { store, open, directory } = temporaryStore(t, { now: () => at });
  const first = store.append(input('upstream-1', '2026-10-14T04:00:00.123Z'));
  assert.equal(first.inserted, true);
  assert.equal(first.comment.received_at, '2026-10-14T12:00:00.123+08:00');
  assert.equal(first.comment.id, String(at));
  assert.deepEqual(Object.keys(first.comment).sort(), [
    'content',
    'id',
    'received_at',
    'user_id',
    'user_name',
  ]);
  assert.equal(store.flush().written, 1);
  const file = jsonFiles(path.join(directory, 'comment_cache'))[0];
  assert.equal(path.basename(file), '1200.json');
  assert.ok(file.includes('2026-10-14'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).comments, [first.comment]);
  store.close();
  const reopened = open();
  const duplicate = reopened.append(input('upstream-1', at + 100));
  assert.deepEqual(duplicate, { inserted: false, comment: first.comment });
  const next = reopened.append(input('upstream-2', at));
  assert.equal(next.comment.id, String(at + 1));
  assert.equal(reopened.stats('shop_01').count, 2);
});

test('minute JSON jobs persist if a process closes before its first export', (t) => {
  const at = Date.parse('2026-10-14T12:00:00+08:00');
  const { store, open, directory } = temporaryStore(t, { now: () => at });
  store.append(input('pending-export', at));
  // Simulate abrupt termination after the committed append, before close/flush.
  store.db.close();
  store.closed = true;
  const reopened = open();
  assert.equal(reopened.flush().written, 1);
  assert.equal(jsonFiles(path.join(directory, 'comment_cache')).length, 1);
  assert.equal(reopened.query('shop_01').comments.length, 1);
});

test('room identities are isolated and repeated messages without upstream IDs remain distinct', (t) => {
  const at = Date.parse('2026-10-14T12:00:00+08:00');
  const { store } = temporaryStore(t, { now: () => at });
  store.append(input('same-id', at));
  store.append(input('same-id', at, { room_number: 'room-B', room_id: '123456789012345679' }));
  store.append(input(null, at));
  store.append(input(null, at));
  assert.equal(store.query('shop_01').comments.length, 3);
  assert.equal(store.query('room-B').comments.length, 1);
  store.append(input('same-id', at, { room_id: 'new-room-id' }));
  assert.equal(store.query('shop_01').room_id, 'new-room-id');
  assert.equal(store.query('shop_01').comments.length, 1);
  assert.equal(store.query('shop_01', { room_id: '123456789012345678' }).comments.length, 3);
});

test('video window includes five minute preroll and excludes the exact end, including pagination', (t) => {
  const start = Date.parse('2026-10-14T12:00:00+08:00');
  const end = Date.parse('2026-10-14T12:15:00+08:00');
  const from = start - 300000;
  const { store } = temporaryStore(t, { now: () => end });
  for (const [name, at] of [
    ['before', from - 1],
    ['from', from],
    ['start', start],
    ['last', end - 1],
    ['end', end],
  ]) {
    store.append(input(name, at, { content: name }));
  }
  const page = store.window('shop_01', { start, end, limit: 2 });
  assert.deepEqual(
    page.comments.map((comment) => comment.content),
    ['from', 'start'],
  );
  assert.equal(page.truncated, true);
  assert.equal(page.next_after_id, page.comments[1].id);
  assert.equal(page.window.comments_from, '2026-10-14T11:55:00.000+08:00');
  const next = store.window('shop_01', { start, end, limit: 2, afterId: page.next_after_id });
  assert.deepEqual(
    next.comments.map((comment) => comment.content),
    ['last'],
  );
  assert.equal(next.truncated, false);
  assert.equal(next.next_after_id, null);
  assert.deepEqual(store.stats('shop_01', { from, to: end }), {
    count: 3,
    current_room_id: '123456789012345678',
    first_received_at: '2026-10-14T11:55:00.000+08:00',
    last_received_at: '2026-10-14T12:14:59.999+08:00',
  });
  assert.throws(() => store.query('shop_01', { limit: 10001 }), /10000/);
});

test('48 hour pruning removes old JSON and rewrites the partly expired minute', (t) => {
  let clock = Date.parse('2026-10-14T12:00:00+08:00');
  const { store, directory, open } = temporaryStore(t, { now: () => clock });
  const twoDays = 48 * 3600000;
  const cutoff = clock - twoDays;
  store.append(input('old-minute', cutoff - 61000));
  store.append(input('partial-expired', cutoff + 10000));
  store.append(input('partial-retained', cutoff + 40000));
  const latest = store.append(input('latest', clock));
  store.flush();
  assert.equal(jsonFiles(path.join(directory, 'comment_cache')).length, 3);
  clock += 30000;
  const result = store.prune();
  assert.equal(result.deleted, 2);
  assert.equal(result.removed_files, 1);
  assert.deepEqual(result.warnings, []);
  const files = jsonFiles(path.join(directory, 'comment_cache'));
  assert.equal(files.length, 2);
  const exported = files.flatMap((file) => JSON.parse(fs.readFileSync(file, 'utf8')).comments);
  assert.equal(exported.length, 2);
  assert.ok(exported.every((comment) => Date.parse(comment.received_at) >= clock - twoDays));
  assert.equal(store.stats('shop_01').count, 2);
  // Counter survives even if all retained comments later expire.
  clock += twoDays + 1;
  store.prune();
  store.close();
  const reopened = open();
  const next = reopened.append(input('new-after-prune', Date.parse(latest.comment.received_at)));
  assert.equal(next.comment.id, String(Number(latest.comment.id) + 1));
  assert.equal(jsonFiles(path.join(directory, 'comment_cache')).length, 0);
});

test('EPERM replacing a JSON file leaves the database intact and the pending export retryable', (t) => {
  const at = Date.parse('2026-10-14T12:00:00+08:00');
  const { store, directory } = temporaryStore(t, { now: () => at });
  store.append(input('first', at));
  store.flush();
  store.append(input('second', at + 1));
  const originalRename = fs.renameSync;
  fs.renameSync = function blockedRename(source, target) {
    if (target.startsWith(directory))
      throw Object.assign(new Error('File is temporarily locked'), { code: 'EPERM' });
    return originalRename(source, target);
  };
  let failed;
  try {
    assert.doesNotThrow(() => {
      failed = store.flush();
    });
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(failed.warnings[0].code, 'EPERM');
  assert.equal(store.stats('shop_01').count, 2);
  const file = jsonFiles(path.join(directory, 'comment_cache'))[0];
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).comments.length, 1);
  assert.equal(store.flush().written, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).comments.length, 2);
  assert.equal(store.append(input('second', at + 100)).inserted, false);
});

test('untrusted room labels cannot escape the cache directory', (t) => {
  const at = Date.parse('2026-10-14T12:00:00+08:00');
  const { store, directory } = temporaryStore(t, { now: () => at });
  store.append(input('first', at, { room_number: '../outside', room_id: '../../escape' }));
  store.flush();
  const files = jsonFiles(path.join(directory, 'comment_cache'));
  assert.equal(files.length, 1);
  assert.ok(files[0].startsWith(`${path.join(directory, 'comment_cache')}${path.sep}`));
  assert.throws(
    () => store.append(input('precision', at, { room_id: 123456789012345678 })),
    /precision/,
  );
});
