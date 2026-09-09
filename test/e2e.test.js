'use strict';

/*
 * End-to-end tests against a real Node-RED runtime (skipped when node-red is
 * not resolvable: set NODE_RED_PATH or `npm install node-red`).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('perf_hooks');

const plugin = require('../lib/runtime.js');
const { findNodeRed, buildChainFlow, startNodeRed, httpJson } = require('./lib/embedded-node-red.js');

const NODE_RED_PATH = findNodeRed();
const HOOK = `onSend.${plugin.HOOK_NAMESPACE}`;

const hostileFunction = `
  msg.payload.image = Buffer.alloc(2 * 1024 * 1024, 9);
  msg.payload.evil = new Proxy({}, {
    get() { throw new Error('trap'); },
    ownKeys() { throw new Error('trap'); },
    getPrototypeOf() { throw new Error('trap'); },
  });
  msg.payload.hop = (msg.payload.hop || 0) + 1;
  return msg;
`;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

test('end to end against a real Node-RED runtime', { skip: !NODE_RED_PATH && 'node-red not installed' }, async (t) => {
  const flow = buildChainFlow(4, [undefined, hostileFunction]);
  const host = await startNodeRed({ nodeRedPath: NODE_RED_PATH, flow });
  const { RED, port, bench } = host;
  const base = `http://127.0.0.1:${port}/rosepetal/message-control`;
  let api;
  try {
    api = plugin(RED);
    const first = RED.nodes.getNode('f1');

    await t.test('messages are delivered untouched while snapshots are taken', async () => {
      const msg = { payload: { hop: 0, text: 'hello' } };
      first.receive(msg);
      await bench.waitFor(1);
      assert.equal(msg.payload.hop, 4, 'message went through every hop');
      assert.equal(msg.payload.image.length, 2 * 1024 * 1024, 'buffer left untouched');
      assert.equal(api.getStats().errors, 0);

      const f3 = await httpJson('GET', `${base}/nodes/f3`);
      assert.equal(f3.status, 200);
      assert.equal(f3.body.type, 'function');
      assert.equal(f3.body.name, 'hop 3');
      assert.equal(f3.body.lastInput.payload.hop, 2, 'input snapshot taken before the node mutated the message');
      assert.equal(f3.body.lastOutput.payload.hop, 3, 'output snapshot taken after');
      assert.equal(f3.body.lastInput.payload.image, '[Buffer withheld: 2097152 bytes]');
      assert.match(f3.body.lastInput.payload.evil, /^\[Unreadable: trap\]$/);
      assert.equal(f3.body.inputCount, 1);
      assert.equal(f3.body.outputCount, 1);

      const list = await httpJson('GET', `${base}/nodes`);
      assert.equal(list.status, 200);
      assert.ok(list.body.some((n) => n.id === 'sink'));
      assert.equal(Object.prototype.hasOwnProperty.call(list.body[0], 'lastInput'), false);
    });

    await t.test('bursts are rate limited per node while every message is counted', async () => {
      const before = (await httpJson('GET', `${base}/nodes/f4`)).body;
      for (let i = 0; i < 200; i += 1) {
        first.receive({ payload: { hop: 0, i } });
      }
      await bench.waitFor(200);
      const after = (await httpJson('GET', `${base}/nodes/f4`)).body;
      assert.equal(after.inputCount, before.inputCount + 200);
      assert.equal(after.outputCount, before.outputCount + 200);
      assert.ok(after.inputSkipped > 150, `most burst messages must be skipped (skipped=${after.inputSkipped})`);
      assert.ok(after.lastInputSeenAt >= after.lastInputAt);
      const stats = (await httpJson('GET', `${base}/stats`)).body;
      assert.equal(stats.errors, 0);
      assert.ok(stats.captures < 60, `captures stay bounded (captures=${stats.captures})`);
      assert.ok(stats.maxCaptureMs < 20, `single capture bounded (max=${stats.maxCaptureMs} ms)`);
    });

    await t.test('disabling removes the hooks from the router; messages keep flowing', async () => {
      const off = await httpJson('POST', `${base}/settings`, { enabled: false });
      assert.equal(off.status, 200);
      assert.equal(off.body.enabled, false);
      assert.equal(RED.hooks.has(HOOK), false);
      first.receive({ payload: { hop: 0 } });
      await bench.waitFor(1);
      assert.deepEqual((await httpJson('GET', `${base}/nodes`)).body, []);

      const on = await httpJson('POST', `${base}/settings`, { enabled: true, captureInterval: 0, captureBudget: 0 });
      assert.equal(on.status, 200);
      assert.deepEqual(on.body, { enabled: true, captureInterval: 0, captureBudget: 0 });
      assert.equal(RED.hooks.has(HOOK), true);
      first.receive({ payload: { hop: 0, marker: 'after-enable' } });
      await bench.waitFor(1);
      const f2 = (await httpJson('GET', `${base}/nodes/f2`)).body;
      assert.equal(f2.lastInput.payload.marker, 'after-enable');
    });

    await t.test('per-message overhead stays negligible', async () => {
      async function measure(count) {
        const samples = [];
        for (let i = 0; i < count; i += 1) {
          const started = performance.now();
          first.receive({ payload: { hop: 0 } });
          await bench.waitFor(1);
          samples.push(performance.now() - started);
        }
        return median(samples);
      }
      await httpJson('POST', `${base}/settings`, { enabled: true, captureInterval: 250, captureBudget: 5 });
      await measure(100); // warm up
      const enabled = await measure(400);
      await httpJson('POST', `${base}/settings`, { enabled: false });
      const disabled = await measure(400);
      // The plugin adds ~0.1 µs per hop on top of Node-RED's own ~20-30 µs per hop.
      assert.ok(enabled <= disabled * 1.5 + 0.2,
        `median latency enabled=${enabled.toFixed(3)} ms vs disabled=${disabled.toFixed(3)} ms`);
    });
  } finally {
    if (api) {
      api.stop();
    }
    await host.stop();
  }
});
