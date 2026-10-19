const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createAtomicJsonWriter } = require('../shared/atomic-json-writer.cjs');
const { beijingTime: beijing, instant } = require('../shared/time.cjs');
const { loadRuntimeConfig, readJson } = require('../config/runtime-config.cjs');
const { createRequestHandler } = require('../http/router.cjs');

/** Coordinates room collectors, durable comments, and bounded validation runs. */
class CollectorService {
  constructor({
    projectRoot = path.resolve(__dirname, '../..'),
    settings,
    rooms,
    store,
    clientFactory,
    restartHandler,
  } = {}) {
    const config = loadRuntimeConfig({ projectRoot, settings, rooms });
    Object.assign(this, config);
    this.restartHandler = restartHandler;
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.outputDir, { recursive: true });
    this.store =
      store ||
      new (require('../infrastructure/storage/comment-store.cjs').CommentStore)({
        dataDir: this.dataDir,
        retentionHours: this.settings.retention_hours || 48,
      });
    for (const [room_number, value] of Object.entries(this.rooms))
      this.store.registerRoom?.({ room_number, room_id: value.room_id });
    this.clientFactory =
      clientFactory ||
      ((options) =>
        new (require('../infrastructure/xiaohongshu/guest-client.cjs').GuestRoomClient)(options));
    this.clients = new Map();
    this.streams = new Map();
    this.activeTest = null;
    this.finalizing = null;
    this.closed = false;
    this.started = Date.now();
    this.cpuStart = process.cpuUsage();
    this.peakRss = 0;
    this.ioHealth = { retries: 0, failures: 0, last_error: null };
    this.writer = createAtomicJsonWriter({
      onRetry: () => this.ioHealth.retries++,
      onError: (file, error) => {
        this.ioHealth.failures++;
        this.ioHealth.last_error = { at: beijing(), file, code: error.code };
        this.log('snapshot_write_error', this.ioHealth.last_error);
      },
    });
    this.httpServer = http.createServer(createRequestHandler(this));
  }
  log(type, details = {}) {
    const row = JSON.stringify({ at: beijing(), type, ...details }) + '\n';
    try {
      fs.appendFileSync(path.join(this.dataDir, 'service_events.jsonl'), row);
      if (this.activeTest)
        fs.appendFileSync(path.join(this.activeTest.output_dir, 'events.jsonl'), row);
    } catch (error) {
      console.error('event log write failed:', error.code);
    }
  }
  viewRoom(number) {
    const config = this.rooms[number],
      client = this.clients.get(number);
    return {
      room_number: number,
      ...config,
      ...(client
        ? client.snapshot()
        : { state: config.enabled ? 'idle' : 'disabled', guest_confirmed: false }),
      cache: this.store.stats(number),
    };
  }
  view() {
    this.peakRss = Math.max(this.peakRss, process.memoryUsage().rss);
    const cpu = process.cpuUsage(this.cpuStart),
      elapsed = Math.max(1, Date.now() - this.started);
    return {
      phase: this.closed ? 'stopped' : 'running',
      pid: process.pid,
      updated_at: beijing(),
      api_url: 'http://' + this.host + ':' + this.port,
      process_started_at: beijing(this.started),
      actual_v1_calls: 0,
      browser_launched: false,
      account_login_actions: 0,
      process_peak_rss_mib: Math.round((this.peakRss / 1048576) * 10) / 10,
      process_cpu_seconds: Math.round((cpu.user + cpu.system) / 100000) / 10,
      process_average_cpu_core_percent:
        Math.round(((cpu.user + cpu.system) / (elapsed * 1000)) * 1000) / 10,
      io_health: this.ioHealth,
      rooms: Object.keys(this.rooms).map((number) => this.viewRoom(number)),
      test: this.activeTest ? this.testSummary() : null,
    };
  }
  testSummary() {
    if (!this.activeTest) return null;
    const test = this.activeTest,
      end = test.finished_at || beijing(Math.min(Date.now(), Date.parse(test.stop_at)));
    const rows = test.room_numbers.map((number) => {
      const row = this.viewRoom(number),
        prior = test.prior_room_snapshots?.[number];
      if (prior) {
        row.subscription_intervals = [
          ...(prior.subscription_intervals || []),
          ...(row.subscription_intervals || []),
        ];
        for (const key of [
          'disconnects',
          'reconnects',
          'kick_events',
          'room_closed_events',
          'received_frames',
          'sent_frames',
          'ws_received_bytes',
          'ws_sent_bytes',
        ])
          row[key] = (row[key] || 0) + (prior[key] || 0);
      }
      return {
        ...row,
        test_comments: this.store.stats(number, { from: test.started_at, to: end }).count,
      };
    });
    let windows = [{ begin: Date.parse(test.started_at), end: Date.parse(end) }];
    for (const row of rows) {
      const intervals = row.subscription_intervals || [],
        next = [];
      for (const w of windows)
        for (const i of intervals) {
          const begin = Math.max(w.begin, Date.parse(i.started_at));
          const finish = Math.min(w.end, i.ended_at ? Date.parse(i.ended_at) : Date.parse(end));
          if (finish > begin) next.push({ begin, end: finish });
        }
      windows = next;
    }
    const sharedCounts = rows.map((row) => ({
      room_number: row.room_number,
      count: windows.reduce(
        (sum, w) =>
          sum +
          this.store.stats(row.room_number, { from: beijing(w.begin), to: beijing(w.end) }).count,
        0,
      ),
    }));
    return {
      ...test,
      updated_at: beijing(),
      pid: process.pid,
      rooms: rows,
      actual_v1_calls: 0,
      raw_frames_enabled: this.settings.raw_frames === true,
      shared_observation_seconds:
        Math.round(windows.reduce((sum, w) => sum + w.end - w.begin, 0)) / 1000,
      shared_subscription_windows: windows.map((w) => ({
        started_at: beijing(w.begin),
        ended_at: beijing(w.end),
      })),
      comments_in_shared_window: sharedCounts,
      all_rooms_comments_verified: rows.every(
        (row) => row.test_comments > 0 && row.guest_confirmed === true,
      ),
      concurrent_comments_verified:
        windows.length > 0 &&
        sharedCounts.every((row) => row.count > 0) &&
        rows.every((row) => row.guest_confirmed === true),
    };
  }
  persist() {
    const status = this.view();
    this.writer.save(path.join(this.dataDir, 'service_state.json'), status);
    if (!this.activeTest) return;
    const test = status.test;
    test.resources = {
      process_peak_rss_mib: status.process_peak_rss_mib,
      process_cpu_seconds: status.process_cpu_seconds,
      process_average_cpu_core_percent: status.process_average_cpu_core_percent,
      resource_note:
        'Sampled process metrics; process restarts are listed separately. WS bytes exclude TLS/TCP overhead and video.',
    };
    this.writer.save(path.join(this.activeTest.output_dir, 'state.json'), test);
    this.writer.save(path.join(this.activeTest.output_dir, 'summary.json'), test);
    this.writer.save(path.join(this.outputDir, 'latest.json'), {
      run_id: test.run_id,
      output_dir: test.output_dir,
      phase: test.phase,
      planned_stop_at: test.stop_at,
      pid: process.pid,
    });
    this.activeTest.last_room_snapshots = Object.fromEntries(
      test.rooms.map((room) => [room.room_number, room]),
    );
    this.writer.save(path.join(this.dataDir, 'current_test.json'), this.activeTest);
  }
  async saveRooms() {
    this.writer.save(this.roomsFile, this.rooms);
    const flushed = await this.writer.flush();
    if (!flushed.ok) throw new Error('configuration persistence failed');
  }
  async startRoom(number, { persistEnabled = true } = {}) {
    if (!this.rooms[number]) throw new Error('unknown room');
    if (persistEnabled) {
      this.rooms[number].enabled = true;
      await this.saveRooms();
    }
    if (
      this.clients.has(number) &&
      !['stopped', 'completed', 'failed', 'idle'].includes(
        this.clients.get(number).snapshot().state,
      )
    )
      return this.viewRoom(number);
    const client = this.clientFactory({
      room: { room_number: number, ...this.rooms[number] },
      onComment: (event) => {
        if (
          this.activeTest &&
          ['running', 'stopping'].includes(this.activeTest.phase) &&
          Date.parse(event.received_at) >= Date.parse(this.activeTest.stop_at)
        )
          return { accepted: false };
        try {
          const saved = this.store.append(event);
          if (saved.inserted)
            for (const response of this.streams.get(number) || [])
              response.write(
                'event: comment\ndata: ' +
                  JSON.stringify({
                    room_number: number,
                    room_id: event.room_id,
                    ...saved.comment,
                  }) +
                  '\n\n',
              );
          return { accepted: saved.inserted, duplicate: !saved.inserted };
        } catch (error) {
          this.log('comment_storage_error', { room_number: number, message: error.message });
          throw error;
        }
      },
      onEvent: (type, details = {}) => {
        this.log(type, { room_number: number, ...details });
      },
      onState: () => {},
      logger: (message) =>
        this.log('client_log', { room_number: number, message: String(message).slice(0, 300) }),
    });
    this.clients.set(number, client);
    client.start();
    this.persist();
    return this.viewRoom(number);
  }
  async stopRoom(number, { persistEnabled = true, reason = 'api_stop' } = {}) {
    if (!this.rooms[number]) throw new Error('unknown room');
    if (this.clients.has(number)) await this.clients.get(number).stop(reason);
    if (persistEnabled) {
      this.rooms[number].enabled = false;
      await this.saveRooms();
    }
    this.persist();
    return this.viewRoom(number);
  }
  async startTest(body, previous = null) {
    if (this.activeTest && ['running', 'stopping'].includes(this.activeTest.phase))
      throw new Error('a test is already running');
    const stopAt = body.stop_at,
      stopMs = instant(stopAt, 'stop_at');
    if (stopMs <= Date.now() || stopMs - Date.now() > 86400000)
      throw new Error('stop_at must be in the next 24 hours');
    const numbers =
      body.room_numbers || Object.keys(this.rooms).filter((number) => this.rooms[number].enabled);
    if (
      !Array.isArray(numbers) ||
      !numbers.length ||
      new Set(numbers).size !== numbers.length ||
      numbers.some((number) => !this.rooms[number])
    )
      throw new Error('room_numbers must list distinct registered rooms');
    const runId =
      previous?.run_id || 'guest_validation_' + beijing().slice(0, 19).replace(/[-:T]/g, '');
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('invalid run_id');
    const dir = path.join(this.outputDir, runId);
    if (!previous && fs.existsSync(dir)) throw new Error('test directory already exists');
    fs.mkdirSync(dir, { recursive: true });
    const historical = previous?.last_room_snapshots || {};
    for (const row of Object.values(historical))
      for (const interval of row.subscription_intervals || [])
        if (!interval.ended_at) {
          interval.ended_at =
            row.last_frame_at && Date.parse(row.last_frame_at) >= Date.parse(interval.started_at)
              ? row.last_frame_at
              : interval.started_at;
          interval.stop_reason = 'service_process_restart';
          interval.end_basis = 'last_recorded_frame';
        }
    this.activeTest = previous
      ? {
          ...previous,
          prior_room_snapshots: historical,
          phase: 'running',
          resume_count: (previous.resume_count || 0) + 1,
          interruptions: [
            ...(previous.interruptions || []),
            {
              previous_pid: previous.pid,
              last_checkpoint_at: previous.checkpoint_at,
              resumed_at: beijing(),
              reason: 'service_process_restart',
            },
          ],
        }
      : {
          run_id: runId,
          output_dir: dir,
          phase: 'running',
          started_at: beijing(),
          stop_at: beijing(stopMs),
          room_numbers: numbers,
          resume_count: 0,
          interruptions: [],
        };
    this.activeTest.pid = process.pid;
    this.activeTest.checkpoint_at = beijing();
    this.stopTimer = setTimeout(
      () =>
        this.finishTest('deadline').catch((error) => {
          this.log('test_finalize_error', { message: error.message });
        }),
      stopMs - Date.now(),
    );
    this.persist();
    const committed = await this.writer.flush();
    if (!committed.ok) {
      clearTimeout(this.stopTimer);
      this.activeTest.phase = 'failed';
      throw new Error('test state persistence failed before startup');
    }
    for (const number of numbers)
      if (this.rooms[number].enabled) await this.startRoom(number, { persistEnabled: false });
    this.log(previous ? 'test_resumed' : 'test_started', {
      run_id: runId,
      stop_at: this.activeTest.stop_at,
    });
    this.persist();
    return this.testSummary();
  }
  async finishTest(reason = 'api_stop') {
    if (this.finalizing) return this.finalizing;
    if (!this.activeTest || this.activeTest.phase !== 'running') return this.activeTest;
    this.finalizing = (async () => {
      clearTimeout(this.stopTimer);
      this.activeTest.phase = 'stopping';
      await Promise.allSettled(
        this.activeTest.room_numbers.map((number) =>
          this.stopRoom(number, { persistEnabled: false, reason }),
        ),
      );
      this.activeTest.phase = 'completed';
      this.activeTest.finished_at = beijing(
        reason === 'deadline' ? Date.parse(this.activeTest.stop_at) : Date.now(),
      );
      this.activeTest.stop_reason = reason;
      this.store.flush();
      this.persist();
      await this.writer.flush();
      const validation = this.validateTest();
      this.writer.save(path.join(this.activeTest.output_dir, 'validation.json'), validation);
      this.activeTest.validation_passed = validation.passed;
      this.log('test_finished', {
        run_id: this.activeTest.run_id,
        stop_reason: reason,
        validation_passed: validation.passed,
      });
      this.persist();
      await this.writer.flush();
      return this.testSummary();
    })();
    try {
      return await this.finalizing;
    } finally {
      this.finalizing = null;
    }
  }
  validateTest() {
    const summary = this.testSummary(),
      expected = ['content', 'id', 'received_at', 'user_id', 'user_name'];
    const rows = summary.room_numbers.map((number) => {
      let afterId,
        count = 0,
        last = -1n;
      const errors = [];
      for (;;) {
        const page = this.store.query(number, {
          from: summary.started_at,
          to: summary.finished_at,
          limit: 10000,
          afterId,
        });
        for (const comment of page.comments) {
          count++;
          if (JSON.stringify(Object.keys(comment).sort()) !== JSON.stringify(expected))
            errors.push('unexpected-fields');
          if (
            !comment.received_at.endsWith('+08:00') ||
            !Number.isFinite(Date.parse(comment.received_at))
          )
            errors.push('invalid-beijing-time');
          if (!/^\d+$/.test(comment.id) || BigInt(comment.id) <= last)
            errors.push('invalid-monotonic-id');
          else last = BigInt(comment.id);
          if (!comment.content.trim()) errors.push('empty-content');
        }
        if (!page.truncated) break;
        afterId = page.next_after_id;
      }
      return {
        room_number: number,
        comment_count: count,
        fields_verified: count > 0 && errors.length === 0,
        errors: [...new Set(errors)],
      };
    });
    const hashes = summary.rooms.map((room) => room.guest_identity_hash).filter(Boolean),
      identities = hashes.length === rows.length && new Set(hashes).size === rows.length;
    return {
      generated_at: beijing(),
      run_id: summary.run_id,
      rooms: rows,
      independent_guest_identities: identities,
      concurrent_comments_verified: summary.concurrent_comments_verified,
      passed:
        identities &&
        summary.concurrent_comments_verified &&
        rows.every((row) => row.fields_verified),
      actual_v1_calls: 0,
      unverified: [
        'full comment delivery completeness',
        'video/comment synchronization',
        '48-hour real-time duration',
        'ten-room capacity',
        'token expiry renewal beyond this run',
      ],
    };
  }
  requestRestart() {
    if (!this.activeTest || this.activeTest.phase !== 'running')
      throw new Error('an active supervised test is required');
    if (typeof this.restartHandler !== 'function')
      throw new Error('service restart requires a supervised CLI process');
    this.log('controlled_restart_requested', { reason: 'recovery_validation' });
    setImmediate(() =>
      Promise.resolve(this.restartHandler(this)).catch((error) => {
        this.log('controlled_restart_error', { message: error.message });
      }),
    );
  }
  async listen() {
    await new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.port, this.host, resolve);
    });
    this.port = this.httpServer.address().port;
    this.maintenance = setInterval(() => {
      try {
        const prune = this.store.prune();
        const flushed = this.store.flush();
        if (prune.warnings?.length || flushed.warnings?.length)
          this.log('cache_io_warnings', { prune: prune.warnings, flush: flushed.warnings });
        if (this.activeTest) this.activeTest.checkpoint_at = beijing();
        this.persist();
      } catch (error) {
        this.log('maintenance_error', { message: error.message });
      }
    }, 10000);
    const previous = readJson(path.join(this.dataDir, 'current_test.json'), null);
    if (
      this.settings.resume_active_test &&
      previous?.phase === 'running' &&
      Date.parse(previous.stop_at) > Date.now()
    )
      await this.startTest(
        { stop_at: previous.stop_at, room_numbers: previous.room_numbers },
        previous,
      );
    this.persist();
    this.log('service_started', { pid: process.pid, host: this.host, port: this.port });
    return this;
  }
  async close(reason = 'service_stop') {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.maintenance);
    clearTimeout(this.stopTimer);
    if (this.activeTest?.phase === 'running' && reason !== 'fatal') await this.finishTest(reason);
    await Promise.allSettled([...this.clients.values()].map((client) => client.stop(reason)));
    if (reason === 'fatal' && this.activeTest?.phase === 'running') {
      this.activeTest.checkpoint_at = beijing();
      this.log('service_interrupted', { reason });
      this.persist();
    }
    for (const streams of this.streams.values()) for (const res of streams) res.end();
    await new Promise((resolve) => this.httpServer.close(resolve));
    this.store.close();
    await this.writer.flush();
  }
}

module.exports = { CollectorService };
