// Independent decoder for the observed public live JSON/Base64 protocol.
// Preserve identifiers before JSON.parse can round unsafe JavaScript integers.
function parseJson(text) {
  const preserved = String(text).replace(
    /"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (token) => {
      if (!/^-?\d{16,}$/.test(token)) return token;
      const value = BigInt(token);
      return value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)
        ? JSON.stringify(token)
        : token;
    },
  );
  return JSON.parse(preserved);
}

function identifier(value) {
  if (value == null) return '';
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new Error('unsafe-numeric-id');
  if (!['string', 'number'].includes(typeof value)) throw new Error('invalid-id-type');
  return String(value);
}

function extractComments(packet) {
  const result = { recognized: false, comments: [], errors: [], event_types: {} };
  if (!packet || typeof packet !== 'object') return result;
  let items, field;
  if (packet.t === 4 && Array.isArray(packet.b?.d?.b)) {
    result.recognized = true;
    if (packet.b.d.biz && packet.b.d.biz !== 'room') return result;
    items = packet.b.d.b;
    field = 'd';
  } else if (Array.isArray(packet.data?.items)) {
    result.recognized = true;
    items = packet.data.items;
    field = 'b';
  } else if (packet.t === 0) {
    result.recognized = true;
    return result;
  } else return result;
  for (let index = 0; index < items.length; index++) {
    try {
      const encoded = items[index]?.[field];
      if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
        throw new Error('invalid-base64-item');
      const inner = parseJson(Buffer.from(encoded, 'base64').toString('utf8'));
      if (inner.command != null && ![1, 2].includes(Number(inner.command))) continue;
      if (inner.roomType && inner.roomType !== 'LIVE') continue;
      const message =
        typeof inner.customData === 'string'
          ? parseJson(inner.customData)
          : inner.customData || inner;
      const eventType = typeof message.type === 'string' ? message.type : 'unknown';
      result.event_types[eventType] = (result.event_types[eventType] || 0) + 1;
      if (message.type !== 'text') continue;
      const content = message.desc ?? message.content?.message ?? message.content?.desc;
      if (typeof content !== 'string' || !content.trim()) throw new Error('missing-comment-text');
      result.comments.push({
        room_id: identifier(inner.roomId ?? message.roomId ?? message.room_id),
        upstream_id: identifier(message.commentId ?? message.comment_id ?? inner.msgId),
        user_id: identifier(message.profile?.user_id ?? message.user_id),
        user_name: String(message.profile?.nickname ?? message.nickname ?? ''),
        content,
        platform_time: message.current_time ?? inner.ts ?? null,
      });
    } catch (error) {
      result.errors.push({ index, reason: error.message });
    }
  }
  return result;
}
module.exports = { parseJson, extractComments };
