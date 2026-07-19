import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { listenWithPortRotation } from './port.js';

test('rotates to another port when the preferred port is occupied', async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address();
  assert.ok(address && typeof address !== 'string');

  const target = createServer();
  try {
    const selected = await listenWithPortRotation(target, '127.0.0.1', address.port, 10);
    assert.ok(selected > address.port);
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => occupied.close(() => resolve())),
      new Promise<void>((resolve) => target.close(() => resolve()))
    ]);
  }
});

test('uses the preferred port when it is available', async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const target = createServer();
  try {
    assert.equal(await listenWithPortRotation(target, '127.0.0.1', port, 3), port);
  } finally {
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});
