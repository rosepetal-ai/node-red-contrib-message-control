'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { createLogBuffer } = require('../lib/logs.js');

function mockLog() {
  const handlers = new Set();
  return {
    addHandler: (h) => handlers.add(h),
    removeHandler: (h) => handlers.delete(h),
    emit: (msg) => { for (const h of handlers) h.emit('log', { timestamp: Date.now(), ...msg }); },
    handlers
  };
}

test('log buffer keeps the last entries, filters by level, text, node, type and time', () => {
  const log = mockLog();
  const buffer = createLogBuffer({ log }, { size: 5, level: 'info', serialize: (v) => v });
  buffer.install();
  assert.equal(log.handlers.size, 1);
  log.emit({ level: 40, msg: 'Starting flows' });
  log.emit({ level: 50, msg: 'debug noise' });
  log.emit({ level: 20, id: 'n1', type: 'mqtt in', name: 'Sensor', z: 't1', msg: new TypeError('Cannot read config') });
  log.emit({ level: 30, id: 'n2', type: 'function', msg: { detail: 'object payload' } });
  const all = buffer.query();
  assert.deepEqual(all.entries.map(e => e.level), ['info', 'error', 'warn'], 'debug not captured at level info');
  assert.equal(all.entries[1].text.split(' (')[0], 'TypeError: Cannot read config');
  assert.equal(all.entries[2].text, '{"detail":"object payload"}');
  assert.deepEqual(buffer.query({ level: 'warn' }).entries.map(e => e.id), ['n1', 'n2']);
  assert.deepEqual(buffer.query({ node: 'n1' }).entries.map(e => e.type), ['mqtt in']);
  assert.deepEqual(buffer.query({ type: 'function' }).entries.map(e => e.id), ['n2']);
  assert.equal(buffer.query({ text: 'starting' }).entries.length, 1);
  assert.equal(buffer.query({ text: 'sensor' }).entries[0].id, 'n1', 'text also matches node name');
  for (let i = 0; i < 10; i += 1) log.emit({ level: 40, msg: `line ${i}` });
  const wrapped = buffer.query({ limit: 2 });
  assert.deepEqual(wrapped.entries.map(e => e.text), ['line 8', 'line 9']);
  assert.equal(wrapped.buffered, 5);
  assert.equal(wrapped.matched, 5);
  assert.equal(wrapped.truncated, true);
  assert.ok(wrapped.droppedBeforeOldest > 0);
  assert.equal(buffer.query({ since: Date.now() + 1000 }).entries.length, 0);
  assert.doesNotThrow(() => log.emit({ level: 'x' }));
  assert.doesNotThrow(() => buffer._handler.emit('log', null));
  buffer.uninstall();
  assert.equal(log.handlers.size, 0);
});

test('long log texts are truncated', () => {
  const log = mockLog();
  const buffer = createLogBuffer({ log }, { size: 3, maxText: 200 });
  buffer.install();
  log.emit({ level: 30, msg: 'x'.repeat(5000) });
  assert.match(buffer.query().entries[0].text, /… \[truncated 4800 chars\]$/);
});


test('errors thrown inside a vm sandbox (function node) are logged with their message', () => {
  const vm = require('vm');
  const log = mockLog();
  const buffer = createLogBuffer({ log }, { size: 3, serialize: () => '[Error]' });
  buffer.install();
  const err = vm.runInNewContext('(() => { try { throw new Error("bad input x"); } catch (e) { return e; } })()');
  assert.equal(err instanceof Error, false, 'the error comes from another realm');
  log.emit({ level: 20, id: 'f1', type: 'function', msg: err });
  assert.match(buffer.query().entries[0].text, /^Error: bad input x/);
});
