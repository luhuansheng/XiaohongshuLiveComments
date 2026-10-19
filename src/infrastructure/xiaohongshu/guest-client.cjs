const crypto = require('node:crypto');
const { parseJson, extractComments } = require('./parser.cjs');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const WS_ENDPOINT = 'wss://apppush-rws.xiaohongshu.com/rwp';
const { beijingTime: stamp } = require('../../shared/time.cjs');

class ClientError extends Error {
  constructor(kind, details = {}) {
    super(kind);
    this.kind = kind;
    this.details = details;
  }
}

// One client owns one isolated visitor and never reads browser/account cookies.
class GuestRoomClient {
  constructor({
    room,
    onComment = () => {},
    onEvent = () => {},
    onState = () => {},
    logger,
    dependencies = {},
  }) {
    if (!room || typeof room.room_id !== 'string' || !/^\d+$/.test(room.room_id))
      throw new Error('room_id must be a numeric string');
    this.room = {
      room_number: String(room.room_number || room.room_id),
      room_id: room.room_id,
      url: room.url || 'https://www.xiaohongshu.com/livestream/' + room.room_id,
    };
    const url = new URL(this.room.url);
    if (
      url.origin !== 'https://www.xiaohongshu.com' ||
      url.pathname !== '/livestream/' + room.room_id
    )
      throw new Error('room URL must match the public Xiaohongshu room');
    this.onComment = onComment;
    this.onEvent = onEvent;
    this.onState = onState;
    this.logger = logger;
    this.signer = dependencies.signer || require('@ikenxuan/xhshow-ts');
    this.WebSocket = dependencies.WebSocket || require('ws');
    this.fetch = dependencies.fetch || globalThis.fetch;
    this.now = dependencies.now || Date.now;
    this.random = dependencies.random || Math.random;
    this.timing = {
      http: 15000,
      ack: 15000,
      heart: 15000,
      watchdog: 5000,
      stale: 65000,
      retryBase: 1000,
      retryMax: 60000,
      closeWait: 1000,
      ...dependencies.timing,
    };
    this.abort = new AbortController();
    this.credentials = null;
    this._task = null;
    this.socket = null;
    this._commentWork = Promise.resolve();
    this._finishedOnlineMs = 0;
    this._currentInterval = null;
    this._roomWasClosed = false;
    this.result = {
      ...this.room,
      state: 'idle',
      phase: 'idle',
      started_at: null,
      updated_at: stamp(this.now()),
      guest_confirmed: false,
      ever_guest_confirmed: false,
      guest_identity_hash: null,
      guest_generations: 0,
      browser_launched: false,
      account_login_actions: 0,
      ws_authenticated: false,
      room_subscribed: false,
      comment_count: 0,
      comments_received: 0,
      received_frames: 0,
      sent_frames: 0,
      ws_received_bytes: 0,
      ws_sent_bytes: 0,
      http_received_body_bytes: 0,
      decode_errors: 0,
      room_mismatches: 0,
      missing_room_ids: 0,
      duplicates: 0,
      callback_errors: 0,
      connection_attempts: 0,
      disconnects: 0,
      reconnects: 0,
      kick_events: 0,
      room_closed_events: 0,
      room_closed_responses: 0,
      heartbeat_acks: 0,
      last_frame_at: null,
      last_heartbeat_ack_at: null,
      token_expiry_seconds: null,
      token_expires_at: null,
      subscription_intervals: [],
      requests: [],
      errors: [],
      event_types: {},
      subscribed_seconds: 0,
    };
  }
  snapshot() {
    const live = this._currentInterval
      ? Math.max(0, this.now() - Date.parse(this._currentInterval.started_at))
      : 0;
    return structuredClone({
      ...this.result,
      subscribed_seconds: (this._finishedOnlineMs + live) / 1000,
    });
  }
  _state(state) {
    if (state) this.result.state = this.result.phase = state;
    this.result.updated_at = stamp(this.now());
    this._callback(this.onState, [this.snapshot()], 'onState');
  }
  _callback(fn, args, name) {
    try {
      Promise.resolve(fn(...args)).catch(() => this._callbackFailure(name));
    } catch {
      this._callbackFailure(name);
    }
  }
  _callbackFailure(name) {
    this.result.callback_errors++;
    const error = { at: stamp(this.now()), reason: 'callback_failed', callback: name };
    this.result.errors.push(error);
    this.result.errors = this.result.errors.slice(-100);
    // Event/state callback errors must not recursively invoke a failing sink.
    if (name !== 'onEvent' && name !== 'logger') this._event('error', error);
  }
  _event(type, details = {}) {
    const safe = { at: stamp(this.now()), room_id: this.room.room_id, ...details };
    this._callback(this.onEvent, [type, safe], 'onEvent');
    if (typeof this.logger === 'function') this._callback(this.logger, [type, safe], 'logger');
  }
  _error(error) {
    // Do not log raw library/network messages, response bodies or credentials.
    const value =
      error instanceof ClientError
        ? { reason: error.kind, ...error.details }
        : {
            reason: 'transport_or_runtime_error',
            code: typeof error?.code === 'string' ? error.code.slice(0, 30) : undefined,
          };
    this.result.errors.push({ at: stamp(this.now()), ...value });
    this.result.errors = this.result.errors.slice(-100);
    this._event('error', value);
  }
  start() {
    if (this._task || this.abort.signal.aborted) return this;
    this.result.started_at = stamp(this.now());
    this._state('starting');
    this._task = this._run().catch((error) => {
      this._error(error);
      this._state('failed');
    });
    return this;
  }
  async stop(reason = 'requested_stop') {
    this.result.stop_reason = String(reason).slice(0, 100);
    if (!this.abort.signal.aborted) {
      this._state('stopping');
      this.abort.abort();
    }
    await this._task;
    await this._commentWork;
    this.result.finished_at = stamp(this.now());
    this._state('completed');
  }
  _ensureCredentials() {
    if (this.credentials) return;
    const config = new this.signer.CryptoConfig().forUserAgent(USER_AGENT);
    const a1 = this.signer.Xhshow.generateA1();
    this.credentials = {
      config,
      client: new this.signer.Xhshow(config),
      session: new this.signer.SessionManager(config),
      exchange: this.signer.createWebSskExchange(config.SSK_SERVER_PUBLIC_KEY),
      deviceId: crypto.randomUUID(),
      fingerprint: String(this.now()),
      cookies: {
        a1,
        webId: this.signer.Xhshow.generateWebId(a1),
        webBuild: '6.57.4',
        xsecappid: 'xhs-pc-web',
      },
      activated: false,
      uid: null,
    };
    this.result.guest_generations++;
    this.result.guest_confirmed = false;
  }
  async _api(uri, method = 'GET', payload) {
    if (this.abort.signal.aborted) throw new ClientError('stopped');
    const c = this.credentials;
    const signed =
      method === 'POST'
        ? c.client.signHeadersPost(uri, c.cookies, 'xhs-pc-web', payload, undefined, c.session)
        : c.client.signHeadersGet(uri, c.cookies, 'xhs-pc-web', undefined, undefined, c.session);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timing.http);
    try {
      const response = await this.fetch('https://edith.xiaohongshu.com' + uri, {
        method,
        headers: {
          ...signed,
          Cookie: Object.entries(c.cookies)
            .map(([k, v]) => k + '=' + v)
            .join('; '),
          'User-Agent': USER_AGENT,
          Origin: 'https://www.xiaohongshu.com',
          Referer: this.room.url,
          'Content-Type': 'application/json',
          c_device_id: c.deviceId,
        },
        body: method === 'POST' ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.any([this.abort.signal, timeout.signal]),
      });
      for (const value of response.headers.getSetCookie?.() || []) {
        const pair = value.split(';')[0],
          at = pair.indexOf('=');
        if (at > 0) c.cookies[pair.slice(0, at)] = pair.slice(at + 1);
      }
      const raw = await response.text();
      this.result.http_received_body_bytes += Buffer.byteLength(raw);
      let body;
      try {
        body = parseJson(raw);
      } catch {
        throw new ClientError('api_non_json', { path: uri, http_status: response.status });
      }
      const record = {
        at: stamp(this.now()),
        path: uri,
        method,
        http_status: response.status,
        code: body.code,
        success: body.success,
        guest: body.data?.guest,
      };
      this.result.requests.push(record);
      this.result.requests = this.result.requests.slice(-100);
      this._event('api', record);
      this._state();
      if (response.status === 401)
        throw new ClientError('guest_session_invalid', { path: uri, http_status: 401 });
      if (response.status !== 200 || body.success !== true)
        throw new ClientError('api_rejected', {
          path: uri,
          http_status: response.status,
          code: body.code,
        });
      return body.data || {};
    } finally {
      clearTimeout(timer);
    }
  }
  async _activate() {
    this._ensureCredentials();
    this._state('activating_guest');
    const c = this.credentials;
    if (!c.activated) {
      const data = await this._api('/api/sns/web/v1/login/activate', 'POST', {
        client_public_key_base64: c.exchange.clientPublicKeyBase64,
      });
      const encrypted = this.signer.extractEncryptedSsk({ data });
      if (encrypted)
        c.session.setWebSsk({ 'xhs-pc-web': c.exchange.acceptEncryptedSsk(encrypted) });
      this.result.ssk_exchanged = !!encrypted;
      if (!c.cookies.web_session && data.session) c.cookies.web_session = data.session;
      c.uid = data.user_id ? String(data.user_id) : null;
      c.activated = true;
    }
    await this._verifyGuest();
  }
  async _verifyGuest() {
    const user = await this._api('/api/sns/web/v2/user/me');
    if (user.guest !== true) throw new ClientError('non_guest_identity_refused');
    const uid = String(user.user_id || this.credentials.uid || '');
    if (!uid) throw new ClientError('missing_guest_uid');
    if (this.credentials.uid && this.result.guest_confirmed && this.credentials.uid !== uid)
      throw new ClientError('guest_identity_changed');
    this.credentials.uid = uid;
    this.result.guest_confirmed = true;
    this.result.ever_guest_confirmed = true;
    this.result.guest_identity_hash = crypto.createHash('sha256').update(uid).digest('hex');
    this.result.credential_source = 'new program-generated visitor only';
    this._state('guest_verified');
  }
  async _getToken() {
    this._state('obtaining_token');
    const data = await this._api('/api/sns/web/v1/celestial/lt');
    const token = data.a_lt || data.aLt;
    if (!token || typeof token !== 'string') throw new ClientError('missing_guest_ws_token');
    const ttl = Number(data.expired_time ?? data.expiredTime);
    this.result.token_expiry_seconds = Number.isFinite(ttl) && ttl > 0 ? ttl : null;
    this.result.token_obtained_at = stamp(this.now());
    this.result.token_expires_at = this.result.token_expiry_seconds
      ? stamp(this.now() + ttl * 1000)
      : null;
    return token;
  }
  _pause(ms) {
    return new Promise((resolve) => {
      if (this.abort.signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.abort.signal.addEventListener('abort', done, { once: true });
    });
  }
  async _run() {
    let failures = 0,
      verifyOnRetry = false;
    while (!this.abort.signal.aborted) {
      let retryMinimum = 0;
      try {
        if (!this.result.guest_confirmed) await this._activate();
        else if (verifyOnRetry) {
          await this._verifyGuest();
          verifyOnRetry = false;
        }
        const token = await this._getToken();
        if (this.abort.signal.aborted) break;
        const outcome = await this._connect(token);
        if (this.abort.signal.aborted) break;
        failures = outcome.subscribed ? 0 : failures + 1;
        verifyOnRetry = outcome.reason === 'auth_rejected';
        retryMinimum = outcome.retryMinimum;
      } catch (error) {
        if (this.abort.signal.aborted) break;
        this._error(error);
        failures++;
        if (
          error.kind === 'non_guest_identity_refused' ||
          error.kind === 'guest_identity_changed'
        ) {
          this.result.guest_confirmed = false;
          this._state('blocked');
          return;
        }
        // Only explicit unauthentication invalidates a visitor. Network, 406,
        // signature or transient token failures keep the existing identity.
        if (error.kind === 'guest_session_invalid') {
          this.credentials = null;
          this.result.guest_confirmed = false;
          this._event('guest_invalidated');
        } else if (this.result.guest_confirmed && failures >= 3) verifyOnRetry = true;
      }
      if (this.abort.signal.aborted) break;
      const exponential = Math.min(
        this.timing.retryMax,
        this.timing.retryBase * 2 ** Math.min(failures, 10),
      );
      const retry = Math.min(
        this.timing.retryMax,
        Math.max(retryMinimum, exponential) * (0.8 + this.random() * 0.4),
      );
      this.result.next_retry_at = stamp(this.now() + retry);
      this._state('waiting_reconnect');
      await this._pause(retry);
    }
  }
  _connect(sid) {
    this.result.connection_attempts++;
    const attempt = this.result.connection_attempts;
    this.result.next_retry_at = null;
    this.result.ws_authenticated = false;
    this.result.room_subscribed = false;
    this._state('ws_connecting');
    const socket = new this.WebSocket(WS_ENDPOINT, {
      origin: 'https://www.xiaohongshu.com',
      handshakeTimeout: this.timing.http,
    });
    this.socket = socket;
    return new Promise((resolve) => {
      let finished = false,
        settled = false,
        everSubscribed = false,
        phaseTimer,
        heartbeat,
        closeTimer;
      let lastFrame = this.now(),
        lastHeartAck = this.now();
      const pending = new Map();
      const complete = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(closeTimer);
        if (this.socket === socket) this.socket = null;
        resolve(outcome);
      };
      let finishOutcome;
      const finish = (reason, closeCode, retryMinimum = 0) => {
        if (finished) return;
        finished = true;
        clearTimeout(phaseTimer);
        clearInterval(heartbeat);
        clearInterval(watchdog);
        pending.clear();
        this.abort.signal.removeEventListener('abort', onStop);
        if (this._currentInterval) {
          const ended = this.now();
          this._currentInterval.ended_at = stamp(ended);
          this._currentInterval.stop_reason = reason;
          this._finishedOnlineMs += Math.max(
            0,
            ended - Date.parse(this._currentInterval.started_at),
          );
          this._currentInterval = null;
        }
        this.result.room_subscribed = false;
        this.result.ws_authenticated = false;
        if (reason !== 'stopped') this.result.disconnects++;
        this.result.last_disconnect = {
          at: stamp(this.now()),
          reason,
          close_code: closeCode,
          attempt,
        };
        this._event('connection_end', this.result.last_disconnect);
        this._state(reason === 'stopped' ? 'stopping' : 'waiting_reconnect');
        finishOutcome = { reason, subscribed: everSubscribed, retryMinimum };
        // The next attempt begins only after this socket closes or is terminated.
        closeTimer = setTimeout(() => complete(finishOutcome), this.timing.closeWait);
        try {
          socket.terminate();
        } catch {
          complete(finishOutcome);
        }
        if (socket.readyState === this.WebSocket.CLOSED || socket.readyState === 3)
          complete(finishOutcome);
      };
      const onStop = () => finish('stopped');
      const send = (packet) => {
        if (
          finished ||
          this.abort.signal.aborted ||
          socket.readyState !== (this.WebSocket.OPEN ?? 1)
        )
          return false;
        const raw = JSON.stringify(packet);
        try {
          socket.send(raw, (error) => {
            if (error && !finished) {
              this._error(new ClientError('socket_send_failed'));
              finish('socket_send_failed');
            }
          });
        } catch {
          this._error(new ClientError('socket_send_failed'));
          finish('socket_send_failed');
          return false;
        }
        this.result.sent_frames++;
        this.result.ws_sent_bytes += Buffer.byteLength(raw);
        return true;
      };
      const signal = (type, data, label) => {
        const mid = crypto.randomUUID();
        pending.set(mid, label);
        clearTimeout(phaseTimer);
        phaseTimer = setTimeout(() => {
          this._error(new ClientError('ack_timeout', { stage: label }));
          finish(label + '_ack_timeout');
        }, this.timing.ack);
        send({ v: 1, t: 2, m: mid, b: { d: { a: 1, s: type, b: data } } });
      };
      const sendHeart = () => {
        send({ v: 1, t: 0 });
        const mid = crypto.randomUUID();
        pending.set(mid, 'heartbeat');
        if (pending.size > 20)
          for (const [key, label] of pending)
            if (label === 'heartbeat') {
              pending.delete(key);
              break;
            }
        const customData = JSON.stringify({
          type: 'viewer_heart',
          priority: 0,
          profile: { user_id: this.credentials.uid, role: 0 },
          source: 'web_live',
          desc: '',
        });
        send({
          v: 1,
          t: 3,
          m: mid,
          b: {
            d: {
              a: 1,
              c: 'liveHeartBeat',
              biz: 'room',
              b: Buffer.from(
                JSON.stringify({
                  roomId: this.room.room_id,
                  roomType: 'LIVE',
                  command: 1,
                  customData,
                }),
              ).toString('base64'),
              e: {},
              s: 'rrmp.o.l',
            },
          },
        });
      };
      const watchdog = setInterval(() => {
        if (
          everSubscribed &&
          (this.now() - lastFrame > this.timing.stale ||
            this.now() - lastHeartAck > this.timing.stale)
        ) {
          this._error(new ClientError('heartbeat_stale'));
          finish('heartbeat_timeout');
        }
      }, this.timing.watchdog);
      this.abort.signal.addEventListener('abort', onStop, { once: true });
      socket.on('upgrade', (response) => {
        this.result.handshake_status = response.statusCode;
      });
      socket.on('open', () => {
        if (finished) return;
        signal(
          0,
          {
            appId: 'xhs-pc',
            authInfo: { authType: 'generic', sid, uid: this.credentials.uid, domain: 'red' },
            deviceInfo: {
              deviceId: this.credentials.deviceId,
              fingerprint: this.credentials.fingerprint,
              platform: 'browser',
              os: 'web',
              osVersion: '10.15',
              deviceName: 'Chrome',
              appVersion: '131.0.0.0',
              userAgent: USER_AGENT,
            },
            serviceTag: '',
            bizInfos: [{ bizName: 'push', serializeType: 'json' }],
            roomInfo: [],
            roomInfos: [],
            tagInfo: [],
            extInfo: {},
            state: 1,
          },
          'auth',
        );
      });
      socket.on('message', (data) => {
        if (finished || this.abort.signal.aborted) return;
        const received = this.now();
        const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        lastFrame = received;
        this.result.last_frame_at = stamp(received);
        this.result.received_frames++;
        this.result.ws_received_bytes += Buffer.byteLength(raw);
        let packet;
        try {
          packet = parseJson(raw);
        } catch {
          this.result.decode_errors++;
          this._state();
          return;
        }
        if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
          this.result.decode_errors++;
          this._state();
          return;
        }
        // ACK transport reception before asynchronous persistence, including
        // malformed entries in a valid SYNC envelope.
        if (packet.t === 4 && packet.b?.d?.a)
          send({ v: 1, t: 4, m: packet.m, b: { a: { c: 0, m: 'success' } } });
        if (packet.t === 2 && packet.b?.d?.a)
          send({ v: 1, t: 2, m: packet.m, b: { a: { c: 0, m: 'success' } } });
        if ((packet.t === 2 || packet.t === 3) && packet.b?.a && pending.has(packet.m)) {
          const label = pending.get(packet.m),
            ack = packet.b.a;
          pending.delete(packet.m);
          if (label === 'heartbeat') {
            if (ack.c === 0) {
              lastHeartAck = this.now();
              this.result.heartbeat_acks++;
              this.result.last_heartbeat_ack_at = stamp(this.now());
            } else {
              this._error(new ClientError('heartbeat_rejected', { code: ack.c }));
              finish('heartbeat_rejected');
              return;
            }
          } else {
            clearTimeout(phaseTimer);
            this.result[label + '_ack'] = { code: ack.c };
            this._event(label + '_ack', { code: ack.c });
            if (ack.c !== 0) {
              if (label === 'join_room' && ack.c === 9001) {
                this.result.room_closed_responses++;
                if (!this._roomWasClosed) this.result.room_closed_events++;
                this._roomWasClosed = true;
              }
              this._error(new ClientError('ack_rejected', { stage: label, code: ack.c }));
              finish(label + '_rejected', undefined, ack.c === 9001 ? this.timing.retryMax : 0);
              return;
            }
            if (label === 'auth') {
              this.result.ws_authenticated = true;
              signal(
                1,
                { bizInfo: { bizName: 'room', serializeType: 'json' }, register: true },
                'biz_register',
              );
            }
            if (label === 'biz_register')
              signal(
                8,
                { info: { bizName: 'room', roomId: this.room.room_id, roomType: 'LIVE' } },
                'join_room',
              );
            if (label === 'join_room') {
              this._roomWasClosed = false;
              everSubscribed = true;
              this.result.room_subscribed = true;
              if (this.result.subscription_started_at) this.result.reconnects++;
              const interval = { attempt, started_at: stamp(this.now()), ended_at: null };
              this._currentInterval = interval;
              this.result.subscription_intervals.push(interval);
              this.result.subscription_intervals = this.result.subscription_intervals.slice(-100);
              this.result.subscription_started_at ||= interval.started_at;
              lastHeartAck = this.now();
              sendHeart();
              heartbeat = setInterval(sendHeart, this.timing.heart);
              this._state('observing_comments');
            }
          }
        }
        if (packet.t === 2 && packet.b?.d && [2, 10, 11].includes(packet.b.d.s)) {
          const type = packet.b.d.s,
            info = packet.b.d.b?.info;
          if (
            type !== 2 &&
            info &&
            (String(info.roomId) !== this.room.room_id || info.roomType !== 'LIVE')
          ) {
            this._event('other_room_signal_ignored', { signal_type: type });
            return;
          }
          if (type === 11) {
            if (!this._roomWasClosed) this.result.room_closed_events++;
            this._roomWasClosed = true;
          } else this.result.kick_events++;
          this._event('server_signal', { signal_type: type });
          finish(type === 11 ? 'room_dismissed' : 'server_kick', undefined, this.timing.retryMax);
          return;
        }
        const decoded = extractComments(packet);
        this.result.decode_errors += decoded.errors.length;
        for (const [type, count] of Object.entries(decoded.event_types))
          this.result.event_types[type] = (this.result.event_types[type] || 0) + count;
        for (const item of decoded.comments) {
          if (!this.result.room_subscribed) continue;
          if (!item.room_id) {
            this.result.missing_room_ids++;
            continue;
          }
          if (item.room_id !== this.room.room_id) {
            this.result.room_mismatches++;
            continue;
          }
          this.result.comments_received++;
          const comment = {
            room_number: this.room.room_number,
            room_id: this.room.room_id,
            upstream_id: item.upstream_id,
            user_id: item.user_id,
            user_name: item.user_name,
            content: item.content,
            received_at: stamp(received),
          };
          this._commentWork = this._commentWork.then(async () => {
            try {
              const result = await this.onComment(comment);
              if (result?.duplicate) this.result.duplicates++;
              else if (result?.accepted !== false) {
                this.result.comment_count++;
                this.result.first_comment_at ||= comment.received_at;
                this.result.last_comment_at = comment.received_at;
              }
            } catch {
              this._callbackFailure('onComment');
            }
            this._state();
          });
        }
        this._state();
      });
      socket.on('error', () => {
        if (!finished) {
          this._error(new ClientError('socket_error'));
          finish('socket_error');
        }
      });
      socket.on('unexpected-response', (_request, response) => {
        this.result.handshake_status = response.statusCode;
        response.resume();
        this._error(new ClientError('upgrade_rejected', { http_status: response.statusCode }));
        finish('upgrade_rejected');
      });
      socket.on('close', (code) => {
        if (finished) complete(finishOutcome);
        else {
          finish('remote_close', code);
          complete(finishOutcome);
        }
      });
      if (this.abort.signal.aborted) finish('stopped');
    });
  }
}

module.exports = { GuestRoomClient, stamp };
