'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const { BEIJING_OFFSET, beijingTime } = require('../../shared/time.cjs');

function timestamp(value, label) {
  const result =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isSafeInteger(result)) throw new TypeError(`${label} must be a valid timestamp`);
  return result;
}

function identifier(value, label) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a string to preserve integer precision`);
  }
  const result = String(value ?? '').trim();
  if (!result || result.length > 255)
    throw new TypeError(`${label} must contain 1 to 255 characters`);
  return result;
}

function safeComponent(value) {
  const slug = value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'room';
  return `${slug}_${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

function commentFromRow(row) {
  return {
    user_id: row.user_id,
    user_name: row.user_name,
    content: row.content,
    id: row.comment_id,
    received_at: row.received_at,
  };
}

/** SQLite is authoritative; minute JSON exports can be retried after transient I/O failures. */
class CommentStore {
  constructor({ dataDir, retentionHours = 48, now = () => Date.now() } = {}) {
    if (!dataDir) throw new TypeError('dataDir is required');
    if (!Number.isFinite(retentionHours) || retentionHours <= 0)
      throw new TypeError('retentionHours must be positive');
    this.dataDir = path.resolve(dataDir);
    this.cacheDir = path.join(this.dataDir, 'comment_cache');
    this.retentionMs = retentionHours * HOUR;
    this.now = now;
    this.closed = false;
    this.warnings = [];
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(this.dataDir, 'comments.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS rooms (
        room_number TEXT PRIMARY KEY,
        current_room_id TEXT NOT NULL,
        last_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comments (
        room_number TEXT NOT NULL,
        room_id TEXT NOT NULL,
        upstream_id TEXT,
        comment_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        content TEXT NOT NULL,
        received_at TEXT NOT NULL,
        received_ms INTEGER NOT NULL,
        minute_ms INTEGER NOT NULL,
        PRIMARY KEY (room_number, comment_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS comments_upstream
        ON comments(room_number, room_id, upstream_id) WHERE upstream_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS comments_room_time
        ON comments(room_number, room_id, received_ms);
      CREATE INDEX IF NOT EXISTS comments_expiry ON comments(received_ms);
      CREATE INDEX IF NOT EXISTS comments_minute ON comments(room_number, room_id, minute_ms);
      CREATE TABLE IF NOT EXISTS minute_exports (
        room_number TEXT NOT NULL,
        room_id TEXT NOT NULL,
        minute_ms INTEGER NOT NULL,
        dirty INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(room_number, room_id, minute_ms)
      );
    `);
  }

  _assertOpen() {
    if (this.closed) throw new Error('CommentStore is closed');
  }

  _cutoff() {
    return timestamp(this.now(), 'now') - this.retentionMs;
  }

  _warn(operation, target, error) {
    const warning = {
      at: beijingTime(this.now()),
      operation,
      target,
      code: error.code || 'IO_ERROR',
      message: error.message,
    };
    this.warnings.push(warning);
    if (this.warnings.length > 100) this.warnings.shift();
    try {
      fs.appendFileSync(
        path.join(this.dataDir, 'store_io_warnings.jsonl'),
        `${JSON.stringify(warning)}\n`,
        'utf8',
      );
    } catch {
      /* An unavailable log destination must not invalidate the durable database. */
    }
    return warning;
  }

  _minutePath(roomNumber, roomId, minuteMs) {
    const date = new Date(minuteMs + BEIJING_OFFSET).toISOString();
    const target = path.resolve(
      this.cacheDir,
      `room_${safeComponent(roomNumber)}`,
      safeComponent(roomId),
      date.slice(0, 10),
      `${date.slice(11, 13)}${date.slice(14, 16)}.json`,
    );
    if (!target.startsWith(`${this.cacheDir}${path.sep}`)) throw new Error('Invalid cache path');
    return target;
  }

  _writeJson(target, value) {
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      fs.renameSync(temporary, target);
      return true;
    } catch (error) {
      this._warn('export_json', target, error);
      try {
        fs.unlinkSync(temporary);
      } catch {
        /* A later flush retries from SQLite. */
      }
      return false;
    }
  }

  registerRoom({ room_number, room_id }) {
    this._assertOpen();
    const roomNumber = identifier(room_number, 'room_number');
    const roomId = identifier(room_id, 'room_id');
    this.db
      .prepare(
        `INSERT INTO rooms(room_number,current_room_id,last_id,updated_at) VALUES(?,?,'0',?)
      ON CONFLICT(room_number) DO UPDATE SET current_room_id=excluded.current_room_id,updated_at=excluded.updated_at`,
      )
      .run(roomNumber, roomId, timestamp(this.now(), 'now'));
    return this.stats(roomNumber);
  }

  append(input) {
    this._assertOpen();
    const roomNumber = identifier(input.room_number, 'room_number');
    const roomId = identifier(input.room_id, 'room_id');
    const upstreamId =
      input.upstream_id == null || input.upstream_id === ''
        ? null
        : identifier(input.upstream_id, 'upstream_id');
    const receivedMs =
      input.received_at == null
        ? timestamp(this.now(), 'now')
        : timestamp(input.received_at, 'received_at');
    const receivedAt = beijingTime(receivedMs);
    const minuteMs = Math.floor(receivedMs / MINUTE) * MINUTE;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (upstreamId !== null) {
        const existing = this.db
          .prepare(
            'SELECT * FROM comments WHERE room_number = ? AND room_id = ? AND upstream_id = ?',
          )
          .get(roomNumber, roomId, upstreamId);
        if (existing) {
          this.db.exec('COMMIT');
          return { inserted: false, comment: commentFromRow(existing) };
        }
      }
      const state = this.db
        .prepare('SELECT last_id FROM rooms WHERE room_number = ?')
        .get(roomNumber);
      const nextId = state ? Math.max(receivedMs, Number(state.last_id) + 1) : receivedMs;
      if (!Number.isSafeInteger(nextId) || nextId < 0)
        throw new RangeError('Comment timestamp ID is out of range');
      const id = String(nextId);
      const comment = {
        user_id: String(input.user_id ?? ''),
        user_name: String(input.user_name ?? ''),
        content: String(input.content ?? ''),
        id,
        received_at: receivedAt,
      };
      this.db
        .prepare(
          `INSERT INTO comments
        (room_number, room_id, upstream_id, comment_id, user_id, user_name, content, received_at, received_ms, minute_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          roomNumber,
          roomId,
          upstreamId,
          id,
          comment.user_id,
          comment.user_name,
          comment.content,
          receivedAt,
          receivedMs,
          minuteMs,
        );
      this.db
        .prepare(
          `INSERT INTO rooms(room_number,current_room_id,last_id,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(room_number) DO UPDATE SET current_room_id=excluded.current_room_id,last_id=excluded.last_id,updated_at=excluded.updated_at`,
        )
        .run(roomNumber, roomId, id, this.now());
      this.db
        .prepare(
          `INSERT INTO minute_exports(room_number,room_id,minute_ms,dirty) VALUES(?,?,?,1)
        ON CONFLICT(room_number,room_id,minute_ms) DO UPDATE SET dirty=1`,
        )
        .run(roomNumber, roomId, minuteMs);
      this.db.exec('COMMIT');
      return { inserted: true, comment };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  _selection(roomNumber, options = {}) {
    const room = this.db
      .prepare('SELECT current_room_id FROM rooms WHERE room_number = ?')
      .get(roomNumber);
    const roomId =
      options.room_id == null
        ? room?.current_room_id || ''
        : identifier(options.room_id, 'room_id');
    const from =
      options.from == null
        ? this._cutoff()
        : Math.max(timestamp(options.from, 'from'), this._cutoff());
    const clauses = ['room_number = ?', 'room_id = ?', 'received_ms >= ?'];
    const parameters = [roomNumber, roomId, from];
    if (options.to != null) {
      clauses.push('received_ms < ?');
      parameters.push(timestamp(options.to, 'to'));
    }
    if (options.afterId != null) {
      if (!/^\d+$/.test(String(options.afterId)) || !Number.isSafeInteger(Number(options.afterId)))
        throw new TypeError('afterId must be a timestamp ID');
      clauses.push('CAST(comment_id AS INTEGER) > ?');
      parameters.push(Number(options.afterId));
    }
    return { roomId, where: clauses.join(' AND '), parameters };
  }

  query(room_number, options = {}) {
    this._assertOpen();
    const roomNumber = identifier(room_number, 'room_number');
    const limit = options.limit == null ? 1000 : options.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000)
      throw new RangeError('limit must be between 1 and 10000');
    const selection = this._selection(roomNumber, options);
    const rows = this.db
      .prepare(
        `SELECT * FROM comments WHERE ${selection.where} ORDER BY CAST(comment_id AS INTEGER) LIMIT ?`,
      )
      .all(...selection.parameters, limit + 1);
    const truncated = rows.length > limit;
    const comments = rows.slice(0, limit).map(commentFromRow);
    return {
      room_number: roomNumber,
      room_id: selection.roomId,
      comments,
      truncated,
      next_after_id: truncated ? comments.at(-1).id : null,
    };
  }

  window(room_number, { start, end, prerollSeconds = 300, limit = 1000, afterId } = {}) {
    if (!Number.isFinite(prerollSeconds) || prerollSeconds < 0)
      throw new RangeError('prerollSeconds must be non-negative');
    const startMs = timestamp(start, 'start');
    const endMs = timestamp(end, 'end');
    if (endMs <= startMs) throw new RangeError('end must be after start');
    const fromMs = Math.round(startMs - prerollSeconds * 1000);
    return {
      ...this.query(room_number, { from: fromMs, to: endMs, limit, afterId }),
      window: {
        video_start: beijingTime(startMs),
        video_end: beijingTime(endMs),
        comments_from: beijingTime(fromMs),
        comments_to_exclusive: beijingTime(endMs),
        preroll_seconds: prerollSeconds,
      },
    };
  }

  stats(room_number, options = {}) {
    this._assertOpen();
    const roomNumber = identifier(room_number, 'room_number');
    const selection = this._selection(roomNumber, options);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count, MIN(received_ms) AS first_ms, MAX(received_ms) AS last_ms FROM comments WHERE ${selection.where}`,
      )
      .get(...selection.parameters);
    return {
      count: row.count,
      current_room_id: selection.roomId,
      first_received_at: row.first_ms == null ? null : beijingTime(row.first_ms),
      last_received_at: row.last_ms == null ? null : beijingTime(row.last_ms),
    };
  }

  flush() {
    this._assertOpen();
    let written = 0;
    let removedFiles = 0;
    const warnings = [];
    const buckets = this.db
      .prepare('SELECT * FROM minute_exports WHERE dirty = 1 ORDER BY minute_ms')
      .all();
    for (const bucket of buckets) {
      const rows = this.db
        .prepare(
          'SELECT * FROM comments WHERE room_number = ? AND room_id = ? AND minute_ms = ? ORDER BY CAST(comment_id AS INTEGER)',
        )
        .all(bucket.room_number, bucket.room_id, bucket.minute_ms);
      const target = this._minutePath(bucket.room_number, bucket.room_id, bucket.minute_ms);
      if (!rows.length) {
        try {
          fs.unlinkSync(target);
          removedFiles++;
        } catch (error) {
          if (error.code !== 'ENOENT') {
            warnings.push(this._warn('remove_expired_json', target, error));
            continue;
          }
        }
        this.db
          .prepare(
            'DELETE FROM minute_exports WHERE room_number = ? AND room_id = ? AND minute_ms = ?',
          )
          .run(bucket.room_number, bucket.room_id, bucket.minute_ms);
        continue;
      }
      if (
        !this._writeJson(target, {
          room_number: bucket.room_number,
          room_id: bucket.room_id,
          comments: rows.map(commentFromRow),
        })
      ) {
        warnings.push(this.warnings.at(-1));
        continue;
      }
      // A concurrent append can occur while another process exports: only clear the job
      // when this snapshot still covers the full minute bucket.
      const lastId = rows.at(-1).comment_id;
      this.db
        .prepare(
          `UPDATE minute_exports SET dirty = 0 WHERE room_number = ? AND room_id = ? AND minute_ms = ?
        AND NOT EXISTS (SELECT 1 FROM comments WHERE room_number = ? AND room_id = ? AND minute_ms = ? AND CAST(comment_id AS INTEGER) > ?)`,
        )
        .run(
          bucket.room_number,
          bucket.room_id,
          bucket.minute_ms,
          bucket.room_number,
          bucket.room_id,
          bucket.minute_ms,
          Number(lastId),
        );
      written++;
    }
    return { written, removed_files: removedFiles, warnings };
  }

  prune() {
    this._assertOpen();
    const cutoff = this._cutoff();
    this.db.exec('BEGIN IMMEDIATE');
    let deleted;
    try {
      this.db
        .prepare(
          `UPDATE minute_exports SET dirty = 1 WHERE EXISTS
        (SELECT 1 FROM comments WHERE comments.room_number = minute_exports.room_number
          AND comments.room_id = minute_exports.room_id AND comments.minute_ms = minute_exports.minute_ms AND received_ms < ?)`,
        )
        .run(cutoff);
      deleted = this.db.prepare('DELETE FROM comments WHERE received_ms < ?').run(cutoff).changes;
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const result = this.flush();
    return { deleted, removed_files: result.removed_files, warnings: result.warnings };
  }

  close() {
    if (this.closed) return;
    try {
      this.flush();
    } finally {
      this.db.close();
      this.closed = true;
    }
  }
}

module.exports = { CommentStore, beijingTime };
