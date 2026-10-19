const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseJson, extractComments } = require('../src/infrastructure/xiaohongshu/parser.cjs');
const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
const message = {
  type: 'text',
  commentId: 'comment-1',
  profile: { user_id: 'user-1', nickname: '观众' },
  desc: '这个多少钱？',
};

test('long numeric identifiers are exact while escaped strings remain untouched', () => {
  const parsed = parseJson(
    '{"roomId":123456789012345681,"s":"123456789012345681 \\"x\\"","small":12,"negative":-123456789012345681}',
  );
  assert.equal(parsed.roomId, '123456789012345681');
  assert.equal(parsed.negative, '-123456789012345681');
  assert.equal(parsed.s, '123456789012345681 "x"');
  assert.equal(parsed.small, 12);
});
test('batched SYNC comments retain room scope and exclude non-comment messages', () => {
  const wrap = (value) => ({
    d: encode({
      command: 1,
      roomType: 'LIVE',
      roomId: '123456789012345681',
      customData: JSON.stringify(value),
    }),
  });
  const result = extractComments({
    t: 4,
    b: {
      d: {
        biz: 'room',
        b: [
          wrap(message),
          wrap({ ...message, type: 'praise' }),
          wrap({ ...message, commentId: 'comment-2' }),
        ],
      },
    },
  });
  assert.equal(result.comments.length, 2);
  assert.equal(result.comments[0].content, message.desc);
  assert.equal(result.comments[0].room_id, '123456789012345681');
  assert.deepEqual(result.errors, []);
});
test('public-page envelope supports its alternative text field', () => {
  const result = extractComments({
    data: {
      items: [
        {
          b: encode({
            customData: {
              type: 'text',
              content: { message: '公开页评论' },
              profile: { nickname: '游客' },
            },
          }),
        },
      ],
    },
  });
  assert.equal(result.comments[0].content, '公开页评论');
});
test('a corrupt batch entry does not discard another valid comment', () => {
  const result = extractComments({
    data: { items: [{ b: '!!!' }, { b: encode({ customData: message }) }] },
  });
  assert.equal(result.errors.length, 1);
  assert.equal(result.comments.length, 1);
});
test('non-room messages and non-live types cannot produce live comments', () => {
  assert.equal(
    extractComments({
      t: 4,
      b: { d: { biz: 'chat', b: [{ d: encode({ customData: message }) }] } },
    }).comments.length,
    0,
  );
  assert.equal(
    extractComments({
      data: { items: [{ b: encode({ roomType: 'OTHER', customData: message }) }] },
    }).comments.length,
    0,
  );
});
test('broadcast command 2 is accepted, unknown commands are excluded', () => {
  const result = extractComments({
    t: 4,
    b: {
      d: {
        biz: 'room',
        b: [
          { d: encode({ command: 2, customData: message }) },
          { d: encode({ command: 1, customData: { type: 'refresh' } }) },
          { d: encode({ command: 3, customData: message }) },
        ],
      },
    },
  });
  assert.equal(result.comments.length, 1);
  assert.deepEqual(result.event_types, { text: 1, refresh: 1 });
});
