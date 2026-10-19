'use strict';

const BEIJING_OFFSET = 8 * 60 * 60 * 1000;
const ISO_ZONE = /(?:Z|[+-]\d\d:\d\d)$/;

/** Keep JSON timestamps explicitly in Beijing time regardless of host timezone. */
function beijingTime(ms = Date.now()) {
  return new Date(ms + BEIJING_OFFSET).toISOString().replace('Z', '+08:00');
}

function instant(value, name) {
  if (typeof value !== 'string' || !ISO_ZONE.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(name + ' requires an ISO timestamp with timezone');
  }
  return Date.parse(value);
}

module.exports = { BEIJING_OFFSET, beijingTime, instant };
