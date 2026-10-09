'use strict';

/*
 * End-to-end test of the real loading path: Node-RED itself loads the plugin
 * from userDir/node_modules before the flows start (skipped when node-red is
 * not resolvable: set NODE_RED_PATH or `npm install node-red`).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { findNodeRed, buildChainFlow, startNodeRed, httpJson } = require('./lib/embedded-node-red.js');

const NODE_RED_PATH = findNodeRed();

test('plugin loaded by Node-RED at start-up records sends of unwired nodes', { skip: !NODE_RED_PATH && 'node-red not installed' }, async () => {
  const flow = buildChainFlow(2);
  flow.push({
    id: 'u1', type: 'function', z: 'tab1', name: 'unwired', func: 'return msg;', outputs: 1,
    timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [], x: 100, y: 200, wires: [[]],
  });
  const host = await startNodeRed({ nodeRedPath: NODE_RED_PATH, flow, installPlugin: true });
  const base = `http://127.0.0.1:${host.port}/rosepetal/message-control`;
  try {
    const settings = await httpJson('GET', `${base}/settings`);
    assert.equal(settings.status, 200, 'the plugin registered its admin routes');
    const u1 = host.RED.nodes.getNode('u1');
    assert.equal(u1.send.name, 'rosepetalUnwiredSend', 'nodes are patched as Node-RED creates them');

    u1.receive({ payload: 'from-unwired' });
    host.RED.nodes.getNode('f1').receive({ payload: { hop: 0 } });
    await host.bench.waitFor(1);

    const deadline = Date.now() + 3000;
    let entry;
    do {
      entry = (await httpJson('GET', `${base}/nodes/u1?history=3`)).body;
      if (entry && entry.outputHistory && entry.outputHistory.length) {
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    } while (Date.now() < deadline);
    assert.equal(entry.outputHistory[0].msg.payload, 'from-unwired');
    assert.equal(entry.outputHistory[0].wired, false);

    const stats = (await httpJson('GET', `${base}/stats`)).body;
    assert.equal(stats.unwired.active, true);
    assert.equal(stats.errors, 0);
    assert.equal(typeof stats.version, 'string');
    const f2 = (await httpJson('GET', `${base}/nodes/f2`)).body;
    assert.equal(f2.inputCount, 1, 'wired nodes are observed through the hooks as before');
  } finally {
    await host.stop();
  }
});
