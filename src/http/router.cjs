const { roomConfig } = require('../config/runtime-config.cjs');
const { beijingTime: beijing, instant } = require('../shared/time.cjs');

async function requestBody(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 131072) throw new Error('request body exceeds 128 KiB');
  }
  return raw ? JSON.parse(raw) : {};
}

/** HTTP translates requests into application operations; it never owns process lifecycle. */
function createRequestHandler(service) {
  return async function handleRequest(req, res) {
    const send = (status, value) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url, 'http://localhost'),
        route = url.pathname;
      if (req.method === 'GET' && route === '/health')
        return send(200, { ok: true, pid: process.pid, now: beijing() });
      if (req.method === 'GET' && route === '/v1/status') return send(200, service.view());
      if (req.method === 'GET' && route === '/v1/rooms')
        return send(200, {
          rooms: Object.keys(service.rooms).map((number) => service.viewRoom(number)),
        });
      if (req.method === 'GET' && route === '/v1/test')
        return send(200, service.testSummary() || { phase: 'idle' });
      if (req.method === 'POST' && route === '/v1/test/start')
        return send(200, await service.startTest(await requestBody(req)));
      if (req.method === 'POST' && route === '/v1/test/stop')
        return send(200, await service.finishTest('api_stop'));
      if (req.method === 'POST' && route === '/v1/service/restart') {
        service.requestRestart();
        return send(202, { accepted: true, restart_by: 'supervisor', preserves_test: true });
      }
      const match = route.match(/^\/v1\/rooms\/([^/]+)(?:\/(start|stop|comments|window|stream))?$/);
      if (!match) return send(404, { error: 'not_found' });
      const number = decodeURIComponent(match[1]),
        action = match[2];
      if (req.method === 'PUT' && !action) {
        if (
          service.clients.has(number) &&
          !['stopped', 'completed', 'failed', 'idle'].includes(
            service.clients.get(number).snapshot().state,
          )
        )
          throw new Error('stop room before changing its configuration');
        service.rooms[number] = roomConfig(number, await requestBody(req));
        service.store.registerRoom?.({
          room_number: number,
          room_id: service.rooms[number].room_id,
        });
        await service.saveRooms();
        return send(200, service.viewRoom(number));
      }
      if (!service.rooms[number]) return send(404, { error: 'unknown_room' });
      if (req.method === 'POST' && action === 'start')
        return send(200, await service.startRoom(number));
      if (req.method === 'POST' && action === 'stop')
        return send(200, await service.stopRoom(number));
      if (req.method === 'GET' && action === 'comments') {
        const options = {
          limit: Number(url.searchParams.get('limit') || 1000),
          afterId: url.searchParams.get('after_id') || undefined,
        };
        for (const key of ['from', 'to'])
          if (url.searchParams.has(key)) {
            instant(url.searchParams.get(key), key);
            options[key] = url.searchParams.get(key);
          }
        return send(200, service.store.query(number, options));
      }
      if (req.method === 'POST' && action === 'window') {
        const body = await requestBody(req);
        instant(body.video_start, 'video_start');
        instant(body.video_end, 'video_end');
        return send(
          200,
          service.store.window(number, {
            start: body.video_start,
            end: body.video_end,
            prerollSeconds: body.preroll_seconds ?? service.settings.preroll_seconds ?? 300,
            limit: body.limit || 1000,
            afterId: body.after_id,
          }),
        );
      }
      if (req.method === 'GET' && action === 'stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        const streams = service.streams.get(number) || new Set();
        streams.add(res);
        service.streams.set(number, streams);
        const ping = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        req.on('close', () => {
          clearInterval(ping);
          streams.delete(res);
        });
        return;
      }
      send(405, { error: 'method_not_allowed' });
    } catch (error) {
      if (!res.headersSent) send(400, { error: error.message });
      else res.end();
    }
  };
}

module.exports = { createRequestHandler };
