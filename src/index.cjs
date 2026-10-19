'use strict';

const { CollectorService } = require('./application/collector-service.cjs');
const { GuestRoomClient } = require('./infrastructure/xiaohongshu/guest-client.cjs');
const { parseJson, extractComments } = require('./infrastructure/xiaohongshu/parser.cjs');
const { CommentStore } = require('./infrastructure/storage/comment-store.cjs');
const { createAtomicJsonWriter } = require('./shared/atomic-json-writer.cjs');
const { beijingTime, instant } = require('./shared/time.cjs');
const { loadRuntimeConfig, roomConfig } = require('./config/runtime-config.cjs');

// Importing the library never opens an API port, creates files, or starts collection.
module.exports = {
  CollectorService,
  GuestRoomClient,
  CommentStore,
  parseJson,
  extractComments,
  createAtomicJsonWriter,
  loadRuntimeConfig,
  roomConfig,
  beijingTime,
  instant,
};
