const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { GuestRoomClient } = require('../src/infrastructure/xiaohongshu/guest-client.cjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error('Mock observation timed out');
}
let generated = 0;
const signer = {
  CryptoConfig: class {
    forUserAgent() {
      this.SSK_SERVER_PUBLIC_KEY = 'mock-key';
      return this;
    }
  },
  Xhshow: class {
    static generateA1() {
      return 'visitor-' + ++generated;
    }
    static generateWebId(a1) {
      return 'web-' + a1;
    }
    signHeadersPost() {
      return { 'x-s': 'mock-signature' };
    }
    signHeadersGet() {
      return { 'x-s': 'mock-signature' };
    }
  },
  SessionManager: class {
    setWebSsk(value) {
      this.ssk = value;
    }
  },
  createWebSskExchange: () => ({
    clientPublicKeyBase64: 'mock-public',
    acceptEncryptedSsk: () => 'mock-ssk',
  }),
  extractEncryptedSsk: (body) => body.data.encrypted_ssk,
};
function response(data, status = 200, success = true) {
  return {
    status,
    headers: { getSetCookie: () => [] },
    text: async () => JSON.stringify({ success, code: success ? 0 : -1, data }),
  };
}
function fixture(options = {}) {
  const sockets = [],
    requests = [],
    comments = [],
    events = [],
    states = [];
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    constructor() {
      super();
      this.readyState = 0;
      this.packets = [];
      sockets.push(this);
      queueMicrotask(() => {
        if (this.readyState !== 3) {
          this.readyState = 1;
          this.emit('open');
        }
      });
    }
    send(raw, callback) {
      const packet = JSON.parse(raw);
      this.packets.push(packet);
      callback?.();
      if (options.autoAck !== false && (packet.t === 2 || packet.t === 3) && packet.b?.d?.a)
        queueMicrotask(() => {
          if (this.readyState === 1) this.ack(packet);
        });
    }
    ack(packet, code = 0) {
      this.receive({ v: 1, t: packet.t, m: packet.m, b: { a: { c: code, m: 'success' } } });
    }
    receive(packet) {
      this.emit('message', Buffer.from(JSON.stringify(packet)));
    }
    terminate() {
      this.readyState = 3;
      queueMicrotask(() => this.emit('close', 1006));
    }
    remoteClose() {
      this.readyState = 3;
      this.emit('close', 1006);
    }
  }
  const fetch = async (url, init) => {
    const request = { path: new URL(url).pathname, init };
    requests.push(request);
    if (options.fetch) return options.fetch(request, requests);
    if (request.path.endsWith('/activate'))
      return response({
        user_id: 'guest-private-id',
        session: 'private-cookie',
        encrypted_ssk: 'encrypted',
      });
    if (request.path.endsWith('/me'))
      return response({ user_id: 'guest-private-id', guest: options.guest !== false });
    return response({ a_lt: 'private-token', expired_time: 10080 });
  };
  const client = new GuestRoomClient({
    room: { room_number: 'test-room', room_id: '123456789012345678' },
    onComment: async (item) => {
      comments.push(item);
      return options.onComment?.(item, comments.length);
    },
    onEvent: (type, data) => events.push({ type, data }),
    onState: (state) => states.push(state),
    logger: options.logger,
    dependencies: {
      signer,
      WebSocket: FakeWebSocket,
      fetch,
      random: () => 0.5,
      timing: {
        http: 100,
        ack: 100,
        heart: 1000,
        watchdog: 20,
        stale: 2000,
        retryBase: 5,
        retryMax: 20,
        closeWait: 10,
        ...options.timing,
      },
    },
  });
  return { client, sockets, requests, comments, events, states };
}
const commentFrame = (roomId, id = 'upstream-1') => ({
  d: Buffer.from(
    JSON.stringify({
      roomId,
      roomType: 'LIVE',
      command: 1,
      customData: JSON.stringify({
        type: 'text',
        commentId: id,
        profile: { user_id: 'u1', nickname: '观众' },
        desc: '价格是多少',
      }),
    }),
  ).toString('base64'),
});

test('bootstrap rejects account identities rather than opening a WS', async () => {
  const f = fixture({ guest: false });
  f.client.start();
  await until(() => f.client.snapshot().state === 'blocked');
  assert.equal(f.sockets.length, 0);
  assert.equal(f.client.snapshot().guest_confirmed, false);
  assert.ok(
    f.events.some(
      (event) => event.type === 'error' && event.data.reason === 'non_guest_identity_refused',
    ),
  );
  await f.client.stop();
});
test('stop aborts in-flight HTTP bootstrap and leaves no pending reconnect', async () => {
  let aborted = false;
  const f = fixture({
    fetch: ({ init }) =>
      new Promise((resolve, reject) =>
        init.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('aborted'));
          },
          { once: true },
        ),
      ),
  });
  f.client.start();
  await until(() => f.requests.length === 1);
  await f.client.stop('deadline');
  assert.equal(aborted, true);
  assert.equal(f.sockets.length, 0);
  assert.equal(f.client.snapshot().state, 'completed');
  const count = f.requests.length;
  await delay(30);
  assert.equal(f.requests.length, count);
});
test('room registration and JOIN wait for ordered successful ACKs', async () => {
  const f = fixture({ autoAck: false });
  f.client.start();
  await until(() => f.sockets[0]?.packets.length === 1);
  const socket = f.sockets[0];
  assert.equal(socket.packets[0].b.d.s, 0);
  assert.equal(socket.packets.length, 1);
  socket.ack(socket.packets[0]);
  assert.equal(socket.packets[1].b.d.s, 1);
  socket.ack(socket.packets[1]);
  assert.equal(socket.packets[2].b.d.s, 8);
  assert.equal(f.client.snapshot().room_subscribed, false);
  socket.ack(socket.packets[2]);
  assert.equal(f.client.snapshot().room_subscribed, true);
  assert.equal(socket.packets[4].b.d.c, 'liveHeartBeat');
  await f.client.stop();
  assert.equal(socket.readyState, 3);
});
test('rejected registration never sends JOIN on that connection', async () => {
  const f = fixture({ autoAck: false });
  f.client.start();
  await until(() => f.sockets[0]?.packets.length === 1);
  const socket = f.sockets[0];
  socket.ack(socket.packets[0]);
  socket.ack(socket.packets[1], 9);
  assert.equal(
    socket.packets.some((packet) => packet.b?.d?.s === 8),
    false,
  );
  assert.equal(f.client.snapshot().room_subscribed, false);
  await f.client.stop();
});
test('a remote disconnect refreshes token and preserves the visitor identity', async () => {
  const f = fixture();
  f.client.start();
  await until(() => f.client.snapshot().room_subscribed);
  const hash = f.client.snapshot().guest_identity_hash;
  const first = f.sockets[0];
  first.remoteClose();
  await until(() => f.sockets.length === 2 && f.client.snapshot().room_subscribed);
  assert.equal(first.readyState, 3);
  assert.equal(f.client.snapshot().guest_identity_hash, hash);
  assert.equal(f.requests.filter((item) => item.path.endsWith('/activate')).length, 1);
  assert.equal(f.requests.filter((item) => item.path.endsWith('/lt')).length, 2);
  assert.equal(f.client.snapshot().guest_generations, 1);
  assert.equal(f.client.snapshot().reconnects, 1);
  const login = f.sockets.map((socket) => socket.packets.find((packet) => packet.b?.d?.s === 0));
  assert.equal(login[0].b.d.b.deviceInfo.deviceId, login[1].b.d.b.deviceInfo.deviceId);
  assert.equal(login[0].b.d.b.authInfo.uid, login[1].b.d.b.authInfo.uid);
  await f.client.stop();
  assert.ok(f.client.snapshot().subscribed_seconds >= 0);
});
test('SYNC reception is ACKed before storage and rejects absent or foreign room IDs', async () => {
  let acknowledgedBeforeStore = false;
  let f;
  f = fixture({
    onComment: () => {
      acknowledgedBeforeStore = f.sockets[0].packets.some(
        (packet) => packet.t === 4 && packet.m === 'sync-1',
      );
    },
  });
  f.client.start();
  await until(() => f.client.snapshot().room_subscribed);
  f.sockets[0].receive({
    v: 1,
    t: 4,
    m: 'sync-1',
    b: {
      d: {
        a: 1,
        biz: 'room',
        b: [
          { d: '!!!' },
          commentFrame('123456789012345678'),
          commentFrame('111'),
          commentFrame(undefined),
        ],
      },
    },
  });
  await until(() => f.client.snapshot().comment_count === 1);
  assert.equal(acknowledgedBeforeStore, true);
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].received_at, /\+08:00$/);
  const result = f.client.snapshot();
  assert.equal(result.decode_errors, 1);
  assert.equal(result.room_mismatches, 1);
  assert.equal(result.missing_room_ids, 1);
  assert.equal(JSON.stringify(result).includes('private-token'), false);
  assert.equal(JSON.stringify(result).includes('private-cookie'), false);
  assert.equal(JSON.stringify(result).includes('guest-private-id'), false);
  await f.client.stop();
});
test('storage callback failure is visible while following comments continue', async () => {
  const f = fixture({
    onComment: (_item, count) => {
      if (count === 1) throw new Error('sensitive-storage-error');
    },
  });
  f.client.start();
  await until(() => f.client.snapshot().room_subscribed);
  f.sockets[0].receive({
    t: 4,
    b: {
      d: {
        biz: 'room',
        b: [commentFrame('123456789012345678', 'a'), commentFrame('123456789012345678', 'b')],
      },
    },
  });
  await until(() => f.client.snapshot().comment_count === 1);
  assert.equal(f.client.snapshot().callback_errors, 1);
  assert.equal(f.client.snapshot().room_subscribed, true);
  assert.ok(
    f.events.some((event) => event.type === 'error' && event.data.callback === 'onComment'),
  );
  await f.client.stop();
});
test('temporary token network failure does not create another guest', async () => {
  let tokenCalls = 0;
  const f = fixture({
    fetch: ({ path }) => {
      if (path.endsWith('/activate')) return response({ user_id: 'guest-private-id' });
      if (path.endsWith('/me')) return response({ guest: true, user_id: 'guest-private-id' });
      if (++tokenCalls === 1) throw new TypeError('network error');
      return response({ a_lt: 'private-token', expired_time: 10080 });
    },
  });
  f.client.start();
  await until(() => f.client.snapshot().room_subscribed);
  assert.equal(f.client.snapshot().guest_generations, 1);
  assert.equal(f.requests.filter((item) => item.path.endsWith('/activate')).length, 1);
  assert.equal(tokenCalls, 2);
  await f.client.stop();
});
test('invalid outer JSON types and a failing logger do not crash live reception', async () => {
  const f = fixture({
    logger: () => {
      throw new Error('logger failed');
    },
  });
  f.client.start();
  await until(() => f.client.snapshot().room_subscribed);
  f.sockets[0].receive(null);
  f.sockets[0].receive([]);
  f.sockets[0].receive({
    t: 4,
    b: { d: { biz: 'room', b: [commentFrame('123456789012345678')] } },
  });
  await until(() => f.client.snapshot().comment_count === 1);
  assert.equal(f.client.snapshot().decode_errors, 2);
  assert.ok(f.client.snapshot().callback_errors > 0);
  assert.equal(f.client.snapshot().room_subscribed, true);
  await f.client.stop();
});
test('missing business heartbeat ACK is detected even while other frames arrive', async () => {
  const f = fixture({ autoAck: false, timing: { stale: 30, watchdog: 5 } });
  f.client.start();
  await until(() => f.sockets[0]?.packets.length === 1);
  const socket = f.sockets[0];
  socket.ack(socket.packets[0]);
  socket.ack(socket.packets[1]);
  socket.ack(socket.packets[2]);
  const timer = setInterval(() => socket.receive({ t: 0 }), 5);
  await until(() => f.client.snapshot().disconnects > 0);
  clearInterval(timer);
  assert.ok(
    f.events.some((event) => event.type === 'error' && event.data.reason === 'heartbeat_stale'),
  );
  await f.client.stop();
});
test('an explicit 401 renews visitor credentials while ordinary 406 does not', async () => {
  let activated = 0,
    tokenCalls = 0;
  const f = fixture({
    fetch: ({ path }) => {
      if (path.endsWith('/activate')) return response({ user_id: 'guest-' + ++activated });
      if (path.endsWith('/me')) return response({ guest: true, user_id: 'guest-' + activated });
      if (++tokenCalls === 1) return response({}, 406, false);
      if (tokenCalls === 2) return response({}, 401, false);
      return response({ a_lt: 'private-token', expired_time: 10080 });
    },
  });
  f.client.start();
  await until(() => f.client.snapshot().room_subscribed);
  assert.equal(activated, 2);
  assert.equal(tokenCalls, 3);
  assert.equal(f.client.snapshot().guest_generations, 2);
  assert.ok(f.events.some((event) => event.type === 'guest_invalidated'));
  await f.client.stop();
});
test('store-reported upstream duplicates do not inflate persisted comment count', async () => {
  const seen = new Set();
  const f = fixture({
    onComment: (item) => {
      if (seen.has(item.upstream_id)) return { duplicate: true };
      seen.add(item.upstream_id);
      return { accepted: true };
    },
  });
  f.client.start();
  await until(() => f.client.snapshot().room_subscribed);
  f.sockets[0].receive({
    t: 4,
    b: {
      d: {
        biz: 'room',
        b: [commentFrame('123456789012345678'), commentFrame('123456789012345678')],
      },
    },
  });
  await until(() => f.client.snapshot().duplicates === 1);
  assert.equal(f.client.snapshot().comment_count, 1);
  assert.equal(f.client.snapshot().comments_received, 2);
  await f.client.stop();
});
test('polling a closed room counts responses separately from a closure transition', async () => {
  const f = fixture({ autoAck: false });
  f.client.start();
  for (let index = 0; index < 2; index++) {
    await until(() => f.sockets[index]?.packets.length === 1);
    const socket = f.sockets[index];
    socket.ack(socket.packets[0]);
    socket.ack(socket.packets[1]);
    socket.ack(socket.packets[2], 9001);
  }
  assert.equal(f.client.snapshot().room_closed_responses, 2);
  assert.equal(f.client.snapshot().room_closed_events, 1);
  await f.client.stop();
});
