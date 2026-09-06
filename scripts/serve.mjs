import { createServer } from 'node:http';
import { resolve } from 'node:path';

// A transport adapter, not another world implementation. No .env is auto-loaded.
process.env.HEARTH_DATA ||= resolve('hearth-data.json');
const { default: handler } = await import('../api/index.js');
const port = Number(process.env.PORT ?? 8788);
const host = process.env.HOST || '127.0.0.1';
const server = createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch(() => {
    if (res.headersSent) return res.destroy();
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error_class: 'transport_failure' }));
  });
});
server.on('error', (error) => {
  console.error(JSON.stringify({ ready: false, error_code: error.code || 'LISTEN_FAILED' }));
  process.exitCode = 1;
});
server.listen({ port, host }, () => {
  console.log(JSON.stringify({ ready: true, origin: `http://${host}:${server.address().port}` }));
});
