const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CollectorService, roomConfig } = require('../src/index.cjs');
const stamp = (ms) => new Date(ms + 28800000).toISOString().replace('Z', '+08:00');
class FakeClient {
  constructor(options) {
    this.options = options;
    this.state = 'idle';
    this.intervals = [];
  }
  start() {
    this.state = 'observing_comments';
    this.intervals.push({ started_at: stamp(Date.now()), ended_at: null });
    return this;
  }
  async stop() {
    this.state = 'stopped';
    for (const i of this.intervals) i.ended_at ||= stamp(Date.now());
  }
  snapshot() {
    return {
      state: this.state,
      guest_confirmed: this.state !== 'idle',
      guest_identity_hash: 'test-' + this.options.room.room_number,
      subscription_intervals: this.intervals,
    };
  }
}
test('room config rejects mismatched URL IDs and account URLs', () => {
  assert.throws(() =>
    roomConfig('a', { room_id: '123', url: 'https://www.xiaohongshu.com/livestream/124' }),
  );
  assert.throws(() => roomConfig('../bad', { room_id: '123' }));
  assert.throws(() => roomConfig('a', { room_id: 123456789012345680 }));
});
test('HTTP start/stop/config, window retrieval and absolute test deadline use durable store', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-service-test-'));
  fs.mkdirSync(path.join(root, 'config'));
  const rooms = {
    shop: { room_id: '123', url: 'https://www.xiaohongshu.com/livestream/123', enabled: true },
  };
  const clients = [];
  const service = await new CollectorService({
    projectRoot: root,
    settings: { port: 0, host: '127.0.0.1' },
    rooms,
    clientFactory: (options) => {
      const client = new FakeClient(options);
      clients.push(client);
      return client;
    },
  }).listen();
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + service.port;
  const call = async (route, method = 'GET', body) => {
    const r = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await call('/v1/rooms/shop/start', 'POST', {})).status, 200);
  const when = Date.now();
  const event = {
    room_number: 'shop',
    room_id: '123',
    upstream_id: 'msg-1',
    user_id: 'user',
    user_name: '观众',
    content: '测试评论',
    received_at: stamp(when),
  };
  clients[0].options.onComment(event);
  const window = await call('/v1/rooms/shop/window', 'POST', {
    video_start: stamp(when + 60000),
    video_end: stamp(when + 120000),
  });
  assert.equal(window.body.comments.length, 1);
  const savedId = window.body.comments[0].id;
  await call('/v1/rooms/shop/stop', 'POST', {});
  await call('/v1/rooms/shop/start', 'POST', {});
  const duplicate = clients[1].options.onComment(event);
  assert.equal(duplicate.duplicate, true);
  assert.equal((await call('/v1/rooms/shop/comments')).body.comments[0].id, savedId);
  await call('/v1/rooms/shop/stop', 'POST', {});
  await call('/v1/rooms/shop/start', 'POST', {});
  const started = await call('/v1/test/start', 'POST', {
    stop_at: stamp(Date.now() + 400),
    room_numbers: ['shop'],
  });
  assert.equal(started.status, 200);
  clients
    .at(-1)
    .options.onComment({ ...event, upstream_id: 'msg-2', received_at: stamp(Date.now()) });
  await new Promise((resolve) => setTimeout(resolve, 750));
  const finished = (await call('/v1/test')).body;
  assert.equal(finished.phase, 'completed');
  assert.equal(finished.stop_reason, 'deadline');
  assert.equal(finished.rooms[0].test_comments, 1);
  const validation = JSON.parse(
    fs.readFileSync(path.join(finished.output_dir, 'validation.json'), 'utf8'),
  );
  assert.equal(validation.passed, true);
});
test('an interrupted service resumes the same test and durable IDs without extending its deadline', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-resume-service-test-'));
  fs.mkdirSync(path.join(root, 'config'));
  const rooms = { shop: { room_id: '123', enabled: true } };
  const clients = [];
  const options = {
    projectRoot: root,
    settings: { port: 0, host: '127.0.0.1', resume_active_test: true },
    rooms,
    clientFactory: (opts) => {
      const c = new FakeClient(opts);
      clients.push(c);
      return c;
    },
  };
  const first = await new CollectorService(options).listen();
  const stopAt = stamp(Date.now() + 1600);
  const test = await first.startTest({ stop_at: stopAt, room_numbers: ['shop'] });
  const event = {
    room_number: 'shop',
    room_id: '123',
    upstream_id: 'durable-msg',
    user_id: 'u',
    user_name: '观众',
    content: '保留ID',
    received_at: stamp(Date.now()),
  };
  clients[0].options.onComment(event);
  const oldId = first.store.query('shop').comments[0].id;
  await first.close('fatal');
  const interrupted = JSON.parse(
    fs.readFileSync(path.join(root, 'data/current_test.json'), 'utf8'),
  );
  assert.equal(interrupted.phase, 'running');
  const second = await new CollectorService(options).listen();
  t.after(async () => {
    await second.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal(second.activeTest.run_id, test.run_id);
  assert.equal(second.activeTest.stop_at, stopAt);
  assert.equal(second.activeTest.resume_count, 1);
  assert.equal(second.store.query('shop').comments[0].id, oldId);
  assert.equal(clients[1].options.onComment(event).duplicate, true);
  await new Promise((resolve) => setTimeout(resolve, 1750));
  assert.equal(second.activeTest.phase, 'completed');
  assert.equal(second.testSummary().rooms[0].test_comments, 1);
});
test('an explicitly disabled room remains stopped when its test resumes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-disabled-resume-test-'));
  fs.mkdirSync(path.join(root, 'config'));
  const factory = (options) => new FakeClient(options);
  const first = await new CollectorService({
    projectRoot: root,
    settings: { port: 0 },
    rooms: { shop: { room_id: '123', enabled: true } },
    clientFactory: factory,
  }).listen();
  await first.startTest({ stop_at: stamp(Date.now() + 5000), room_numbers: ['shop'] });
  await first.stopRoom('shop');
  await first.close('fatal');
  const second = await new CollectorService({
    projectRoot: root,
    settings: { port: 0, resume_active_test: true },
    clientFactory: factory,
  }).listen();
  t.after(async () => {
    await second.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal(second.rooms.shop.enabled, false);
  assert.equal(second.clients.size, 0);
  assert.equal(second.activeTest.phase, 'running');
});
