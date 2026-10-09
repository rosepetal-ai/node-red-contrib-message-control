'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { createSender } = require('../lib/send.js');

test('send delivers to the node input on the next tick and refuses nodes without input', async () => {
  const received = [];
  const fn = Object.assign(new EventEmitter(), { id: 'fn', type: 'function', name: 'calc', _inputCallback: () => {}, receive: (m) => received.push(m) });
  const cfg = Object.assign(new EventEmitter(), { id: 'cfg', type: 'mqtt-broker', receive: () => {} });
  const nodes = { fn, cfg };
  const sender = createSender({ nodes: { getNode: (id) => nodes[id] || null }, util: { generateId: () => 'gen-1' } });
  const t0 = Date.now();
  const { at, ...result } = sender.send('fn', { payload: 42 });
  assert.deepEqual(result, { id: 'fn', type: 'function', name: 'calc', msgid: 'gen-1' });
  assert.ok(at >= t0 && at <= Date.now(), 'runtime time of the send');
  assert.equal(received.length, 0, 'not delivered inside the request');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(received, [{ payload: 42, _msgid: 'gen-1' }]);
  assert.throws(() => sender.send('cfg', {}), { status: 409, code: 'no_input', message: /has no input/ });
  assert.throws(() => sender.send('nope', {}), { status: 404, code: 'unknown_node', message: /not running/ });
  assert.throws(() => sender.send('fn', 'text'), { status: 400, code: 'invalid_request', message: /msg must be an object/ });
});
