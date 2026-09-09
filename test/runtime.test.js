'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const path = require('path');
const fs = require('fs');
const { performance } = require('perf_hooks');

const plugin = require('../lib/runtime.js');
const { findNodeRed } = require('./lib/embedded-node-red.js');

const { snapshotMessage, DEFAULT_LIMITS, HOOK_NAMESPACE } = plugin;
const ON_SEND = `onSend.${HOOK_NAMESPACE}`;
const ON_RECEIVE = `onReceive.${HOOK_NAMESPACE}`;

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// Mirrors @node-red/util hooks semantics: 1-arg handlers run synchronously,
// a `false` return halts the flow, a throw reaches done(err).
function createHooksEngine() {
  const hooks = {};
  return {
    add(hookId, cb) {
      const [id, label] = hookId.split('.');
      hooks[id] = hooks[id] || [];
      if (hooks[id].some((h) => h.label === label)) {
        throw new Error(`Hook ${hookId} already registered`);
      }
      hooks[id].push({ label, cb });
    },
    remove(hookId) {
      const [id, label] = hookId.split('.');
      if (!label) {
        throw new Error(`Cannot remove hook without label: ${hookId}`);
      }
      if (hooks[id]) {
        hooks[id] = hooks[id].filter((h) => h.label !== label);
      }
    },
    has(hookId) {
      const [id, label] = hookId.split('.');
      return !!(hooks[id] && hooks[id].some((h) => h.label === label));
    },
    trigger(id, payload, done) {
      for (const h of hooks[id] || []) {
        let result;
        try {
          result = h.cb.length === 1 ? h.cb(payload) : undefined;
        } catch (err) {
          done(err);
          return;
        }
        if (result === false) {
          done(false);
          return;
        }
      }
      done();
    },
    handlers(id) {
      return (hooks[id] || []).map((h) => h.cb);
    },
  };
}

function createMockRED({ configNodes = [], settings = {} } = {}) {
  const routes = [];
  const logs = { info: [], warn: [] };
  return {
    nodes: {
      eachNode(cb) {
        configNodes.forEach(cb);
      },
      getNode() {
        return null;
      },
    },
    hooks: createHooksEngine(),
    settings,
    log: {
      info: (m) => logs.info.push(String(m)),
      warn: (m) => logs.warn.push(String(m)),
    },
    events: new EventEmitter(),
    httpAdmin: {
      get(route, ...handlers) {
        routes.push({ method: 'get', route, handler: handlers[handlers.length - 1] });
      },
      post(route, ...handlers) {
        routes.push({ method: 'post', route, handler: handlers[handlers.length - 1] });
      },
    },
    auth: {
      needsPermission() {
        return (req, res, next) => next();
      },
    },
    _routes: routes,
    _logs: logs,
    _configNodes: configNodes,
  };
}

function createClock(start = 1000000) {
  const clock = {
    now: start,
    hr: 0,
    hrStep: 0,
    read: () => clock.now,
    readHr: () => {
      clock.hr += clock.hrStep;
      return clock.hr;
    },
  };
  return clock;
}

function makeInstance(options = {}) {
  const RED = createMockRED(options);
  const clock = createClock();
  const api = plugin.create(RED, { now: clock.read, hrNow: clock.readHr, disableClockTimer: true });
  // Advance the coarse clock and let the instance observe it.
  const advance = (ms) => {
    clock.now += ms;
    api._tick();
  };
  return { RED, api, clock, advance };
}

function sendEvents(sourceId, msg, destId = 'dest') {
  return [{
    msg,
    source: { id: sourceId, node: { id: sourceId, type: 'function', name: `${sourceId} name` }, port: 0 },
    destination: { id: destId, node: undefined },
    cloneMessage: false,
  }];
}

function receiveEvent(destId, msg) {
  return { msg, destination: { id: destId, node: { id: destId, type: 'change', name: `${destId} name` } } };
}

function throwingProxy(message = 'boom') {
  const fail = () => {
    throw new Error(message);
  };
  return new Proxy({}, {
    get: fail, has: fail, ownKeys: fail, getOwnPropertyDescriptor: fail, getPrototypeOf: fail,
  });
}

function deepFreeze(value, seen = new Set()) {
  if (value && typeof value === 'object' && !seen.has(value) && !Buffer.isBuffer(value)) {
    seen.add(value);
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze(value[key], seen);
    }
  }
  return value;
}

function findRoute(RED, method, suffix) {
  const route = RED._routes.find((r) => r.method === method && r.route.endsWith(suffix));
  assert.ok(route, `route ${method} ${suffix} registered`);
  return route.handler;
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      res.done && res.done();
      return res;
    },
  };
  res.finished = new Promise((resolve) => { res.done = resolve; });
  return res;
}

// ---------------------------------------------------------------------------
// snapshotMessage
// ---------------------------------------------------------------------------

test('snapshot keeps plain JSON data intact and normalises exotic primitives', () => {
  const out = snapshotMessage({
    a: 1, b: 'two', c: true, d: null, e: [1, 'x', { f: 2 }], g: { h: { i: [] } },
    nan: NaN, inf: -Infinity, big: 12n, fn: function named() {}, sym: Symbol('s'), undef: undefined,
  });
  assert.deepEqual(out, {
    a: 1, b: 'two', c: true, d: null, e: [1, 'x', { f: 2 }], g: { h: { i: [] } },
    nan: 'NaN', inf: '-Infinity', big: '12n', fn: '[Function named]', sym: 'Symbol(s)', undef: undefined,
  });
  assert.doesNotThrow(() => JSON.stringify(out));
});

test('snapshot withholds binary payloads without touching their bytes', () => {
  const buf = Buffer.alloc(1024 * 1024, 7);
  const out = snapshotMessage({
    buf,
    u8: new Uint8Array(10),
    f32: new Float32Array(3),
    ab: new ArrayBuffer(16),
    dv: new DataView(new ArrayBuffer(8)),
    json: { type: 'Buffer', data: [1, 2, 3] },
  });
  assert.deepEqual(out, {
    buf: '[Buffer withheld: 1048576 bytes]',
    u8: '[Uint8Array withheld: 10 items]',
    f32: '[Float32Array withheld: 3 items]',
    ab: '[ArrayBuffer withheld: 16 bytes]',
    dv: '[DataView withheld: 8 bytes]',
    json: '[Buffer withheld: 3 bytes]',
  });
  assert.equal(buf[0], 7);
});

test('snapshot represents dates, regexps, errors, collections and promises safely', () => {
  const out = snapshotMessage({
    date: new Date('2026-09-09T10:00:00.000Z'),
    bad: new Date('nope'),
    re: /a+/gi,
    err: new TypeError('broken'),
    map: new Map([[1, 2]]),
    set: new Set([1, 2, 3]),
    promise: Promise.resolve(1),
    weak: new WeakMap(),
  });
  assert.deepEqual(out, {
    date: '2026-09-09T10:00:00.000Z',
    bad: 'Invalid Date',
    re: '/a+/gi',
    err: { name: 'TypeError', message: 'broken' },
    map: '[Map withheld: 1 entries]',
    set: '[Set withheld: 3 entries]',
    promise: '[Promise]',
    weak: '[WeakMap]',
  });
});

test('snapshot never walks into event emitters, streams or HTTP objects', () => {
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.secret = Buffer.alloc(10 * 1024 * 1024);
    }
  }
  const stream = new PassThrough();
  class Duck {
    constructor() {
      this.internals = { huge: 'x'.repeat(100000) };
    }

    on() {}

    emit() {}
  }
  const plain = { on() {}, emit() {}, data: 1 };
  const out = snapshotMessage({ req: new FakeSocket(), res: { _res: stream }, duck: new Duck(), plain });
  assert.equal(out.req, '[FakeSocket withheld: event emitter]');
  assert.equal(out.res._res, '[PassThrough withheld: event emitter]');
  assert.equal(out.duck, '[Duck withheld: event emitter]', 'duck-typed emitters (other EventEmitter implementations) are withheld');
  assert.deepEqual(out.plain, { on: '[Function on]', emit: '[Function emit]', data: 1 }, 'plain data objects are always walked');
});

test('snapshot marks true cycles but expands shared references', () => {
  const shared = { v: 1 };
  const msg = { a: shared, b: shared };
  msg.self = msg;
  msg.a.parent = msg;
  const out = snapshotMessage(msg);
  assert.deepEqual(out.a, { v: 1, parent: '[Circular]' });
  assert.deepEqual(out.b, { v: 1, parent: '[Circular]' });
  assert.equal(out.self, '[Circular]');
});

test('snapshot enforces depth, key and array limits', () => {
  let deep = { leaf: true };
  for (let i = 0; i < 10; i += 1) {
    deep = { child: deep, arr: [1] };
  }
  const wide = {};
  for (let i = 0; i < 100; i += 1) {
    wide[`k${i}`] = i;
  }
  const out = snapshotMessage({ deep, wide, list: Array.from({ length: 120 }, (_, i) => i) });

  let cursor = out.deep;
  for (let i = 0; i < 4; i += 1) {
    cursor = cursor.child;
  }
  assert.equal(cursor.child, '[Object with 2 keys]');
  assert.equal(cursor.arr, '[Array(1)]');

  assert.equal(Object.keys(out.wide).length, DEFAULT_LIMITS.maxObjectKeys + 2);
  assert.equal(out.wide.__rosepetalCleanTruncated, true);
  assert.equal(out.wide.__rosepetalCleanNote, '40 more keys not shown');

  assert.equal(out.list.length, DEFAULT_LIMITS.maxArrayLength + 1);
  assert.equal(out.list[DEFAULT_LIMITS.maxArrayLength], '… 70 more items');
});

test('snapshot truncates long strings and detects base64 / data URLs by prefix only', () => {
  const long = 'y'.repeat(5000);
  const base64 = Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 37) % 251)).toString('base64');
  const wrapped = base64.replace(/(.{76})/g, '$1\r\n');
  const dataUrl = `  data:image/png;base64,${base64}`;
  const prose = 'The quick brown fox jumps over the lazy dog '.repeat(20);
  const out = snapshotMessage({ long, base64, wrapped, dataUrl, prose, short: 'abc' });
  assert.equal(out.long, `${'y'.repeat(DEFAULT_LIMITS.maxStringLength)}… [truncated ${5000 - DEFAULT_LIMITS.maxStringLength} chars]`);
  assert.equal(out.base64, `[Base64 withheld: ${base64.length} chars]`);
  assert.equal(out.wrapped, `[Base64 withheld: ${wrapped.length} chars]`);
  assert.equal(out.dataUrl, `[DataImage withheld: ${dataUrl.length} chars]`);
  assert.equal(out.prose, prose, 'plain text with spaces is never mistaken for base64');
  assert.equal(out.short, 'abc');
});

test('snapshot caps the total number of values and characters visited', () => {
  const wide = {};
  for (let i = 0; i < 100; i += 1) {
    wide[`k${i}`] = `v${i}`;
  }
  const out = snapshotMessage(wide, { ...DEFAULT_LIMITS, maxValues: 10 });
  const shownKeys = Object.keys(out).filter((k) => !k.startsWith('__rosepetal'));
  assert.equal(shownKeys.length, 9, 'root object + 9 children = 10 values');
  assert.equal(out.__rosepetalCleanNote, '91 more keys not shown');

  const strings = { a: 'x'.repeat(100), b: 'y'.repeat(100), c: 'z'.repeat(100) };
  const capped = snapshotMessage(strings, { ...DEFAULT_LIMITS, maxChars: 150 });
  assert.equal(capped.a, 'x'.repeat(100));
  assert.equal(capped.b, `${'y'.repeat(50)}… [truncated 50 chars]`);
  assert.equal(capped.c, '[String withheld: 100 chars]');

  const bigArray = snapshotMessage({ arr: Array.from({ length: 30 }, (_, i) => ({ i })) }, { ...DEFAULT_LIMITS, maxValues: 6 });
  assert.equal(bigArray.arr[bigArray.arr.length - 1], '… 28 more items (truncated)');
});

test('snapshot survives throwing getters and hostile proxies', () => {
  const msg = {
    ok: 1,
    get bad() {
      throw new Error('getter exploded');
    },
    proxy: throwingProxy('trap'),
  };
  const out = snapshotMessage(msg);
  assert.equal(out.ok, 1);
  assert.equal(out.bad, '[Unreadable: getter exploded]');
  assert.match(String(out.proxy), /^\[Unreadable: trap\]$/);
  assert.doesNotThrow(() => snapshotMessage(throwingProxy()));
});

test('snapshot never mutates the message (unlike RED.util.cloneMessage)', () => {
  const req = new EventEmitter();
  const msg = { req, payload: { a: [1, { b: 2 }] }, res: { _res: req }, topic: 't' };
  const keysBefore = Object.keys(msg);
  const json = JSON.stringify(msg.payload);
  deepFreeze(msg.payload);
  assert.doesNotThrow(() => snapshotMessage(msg));
  assert.deepEqual(Object.keys(msg), keysBefore);
  assert.equal(msg.req, req);
  assert.equal(JSON.stringify(msg.payload), json);
});

test('snapshot names class instances and walks their own properties', () => {
  class Empty {}
  class Dto {
    constructor() {
      this.id = 5;
    }
  }
  const nullProto = Object.create(null);
  nullProto.x = 1;
  const out = snapshotMessage({ empty: new Empty(), dto: new Dto(), nullProto });
  assert.deepEqual(out, { empty: '[Empty]', dto: { id: 5 }, nullProto: { x: 1 } });
});

test('snapshot cost does not scale with the size of huge strings, arrays or buffers', () => {
  const huge = {
    text: 'a'.repeat(20 * 1000 * 1000),
    list: new Array(5 * 1000 * 1000).fill(0),
    image: Buffer.alloc(32 * 1024 * 1024),
    nested: { deeper: { text: 'b'.repeat(1000 * 1000), list: new Array(1000 * 1000).fill({ x: 1 }) } },
  };
  snapshotMessage(huge); // warm up
  const started = performance.now();
  const out = snapshotMessage(huge);
  const elapsed = performance.now() - started;
  assert.equal(out.image, '[Buffer withheld: 33554432 bytes]');
  assert.equal(out.list.length, DEFAULT_LIMITS.maxArrayLength + 1);
  assert.equal(out.text.length, DEFAULT_LIMITS.maxStringLength + '… [truncated 19997952 chars]'.length);
  assert.ok(elapsed < 5, `snapshot of a 50+ MB message took ${elapsed.toFixed(2)} ms`);
});

test('huge dictionaries are handled with a bounded number of keys and trigger a capture backoff', () => {
  const dict = {};
  for (let i = 0; i < 200000; i += 1) {
    dict[`key${i}`] = i;
  }
  const out = snapshotMessage({ dict });
  assert.equal(Object.keys(out.dict).length, DEFAULT_LIMITS.maxObjectKeys + 2);
  assert.equal(out.dict.__rosepetalCleanNote, '1000+ more keys not shown');

  const { api, clock, advance } = makeInstance();
  clock.hrStep = 3; // simulate a capture slower than the 2 ms threshold
  api._hooks.onSend(sendEvents('slow', { payload: 1 }));
  assert.equal(api.getStats().slowCaptures, 1);
  advance(1000);
  api._hooks.onSend(sendEvents('slow', { payload: 2 }));
  assert.deepEqual(api.getLastMessageForNode('slow').lastOutput, { payload: 1 }, 'slow node is not sampled again within the backoff');
  clock.hrStep = 0;
  api._hooks.onSend(sendEvents('fast', { payload: 'f' }));
  assert.deepEqual(api.getLastMessageForNode('fast').lastOutput, { payload: 'f' }, 'other nodes are unaffected');
  advance(10000);
  api._hooks.onSend(sendEvents('slow', { payload: 3 }));
  assert.deepEqual(api.getLastMessageForNode('slow').lastOutput, { payload: 3 });
  api.stop();
});

// ---------------------------------------------------------------------------
// Hooks and instance behaviour
// ---------------------------------------------------------------------------

test('registers synchronous one-argument hooks and removes them when disabled', () => {
  const { RED, api } = makeInstance();
  assert.ok(RED.hooks.has(ON_SEND));
  assert.ok(RED.hooks.has(ON_RECEIVE));
  for (const id of ['onSend', 'onReceive']) {
    const handlers = RED.hooks.handlers(id);
    assert.equal(handlers.length, 1);
    assert.equal(handlers[0].length, 1, `${id} handler must take exactly one argument (sync path)`);
  }
  api.updateSettings({ enabled: false });
  assert.equal(RED.hooks.has(ON_SEND), false);
  assert.equal(RED.hooks.has(ON_RECEIVE), false);
  assert.equal(api.getStats().hooksInstalled, false);
  api.updateSettings({ enabled: true });
  assert.ok(RED.hooks.has(ON_SEND));
  assert.ok(RED.hooks.has(ON_RECEIVE));
  api.stop();
  assert.equal(RED.hooks.has(ON_SEND), false);
});

test('hooks never return a value and never throw, whatever the event looks like', () => {
  const { RED, api } = makeInstance();
  const { onSend, onReceive } = api._hooks;
  const hostile = [
    undefined, null, 42, 'str', {}, [], [null], [{}], [{ msg: null, source: { id: 'a' } }],
    [{ msg: throwingProxy(), source: { id: 'a', node: throwingProxy() } }],
    throwingProxy(),
    { msg: { a: 1 } },
    { msg: throwingProxy(), destination: { id: 'x', node: null } },
    { msg: { a: 1 }, destination: throwingProxy() },
  ];
  for (const event of hostile) {
    assert.equal(onSend(event), undefined);
    assert.equal(onReceive(event), undefined);
  }
  // Through the engine the message path must continue (done() with no error).
  let outcome = 'not called';
  RED.hooks.trigger('onReceive', { msg: throwingProxy(), destination: throwingProxy() }, (err) => { outcome = err; });
  assert.equal(outcome, undefined);
  RED.hooks.trigger('onSend', throwingProxy(), (err) => { outcome = err; });
  assert.equal(outcome, undefined);
  api.stop();
});

test('hook errors are counted and logged at most once per minute', () => {
  const { RED, api, advance } = makeInstance();
  const evil = { msg: { a: 1 }, destination: throwingProxy() };
  api._hooks.onReceive(evil);
  api._hooks.onReceive(evil);
  api._hooks.onReceive(evil);
  assert.equal(api.getStats().errors, 3);
  assert.equal(RED._logs.warn.length, 1);
  advance(61000);
  api._hooks.onReceive(evil);
  assert.equal(RED._logs.warn.length, 2);
  api.stop();
});

test('captures the first message in each direction with exact timestamps', () => {
  const { api, clock } = makeInstance();
  const msg = { _msgid: '1', payload: { hop: 1, image: Buffer.alloc(100) } };
  api._hooks.onSend(sendEvents('n1', msg));
  api._hooks.onReceive(receiveEvent('n2', msg));
  const n1 = api.getLastMessageForNode('n1');
  const n2 = api.getLastMessageForNode('n2');
  assert.deepEqual(n1.lastOutput, { _msgid: '1', payload: { hop: 1, image: '[Buffer withheld: 100 bytes]' } });
  assert.equal(n1.lastOutputAt, clock.now);
  assert.equal(n1.lastOutputSeenAt, clock.now);
  assert.equal(n1.lastInput, null);
  assert.equal(n1.outputCount, 1);
  assert.equal(n1.type, 'function');
  assert.equal(n1.name, 'n1 name');
  assert.deepEqual(n2.lastInput, n1.lastOutput);
  assert.equal(n2.inputCount, 1);
  assert.equal(n2.type, 'change');
  assert.deepEqual(Object.keys(n1).sort(), [
    'id', 'inputCount', 'inputSkipped', 'lastInput', 'lastInputAt', 'lastInputSeenAt',
    'lastOutput', 'lastOutputAt', 'lastOutputSeenAt', 'name', 'outputCount', 'outputSkipped', 'type',
  ]);
  api.stop();
});

test('rate limits snapshots per node and direction, but keeps counting', () => {
  const { api, clock, advance } = makeInstance();
  api._hooks.onSend(sendEvents('n1', { payload: 1 }));
  const firstAt = clock.now;
  advance(100);
  api._hooks.onSend(sendEvents('n1', { payload: 2 }));
  advance(100);
  api._hooks.onSend(sendEvents('n1', { payload: 3 }));
  let entry = api.getLastMessageForNode('n1');
  assert.deepEqual(entry.lastOutput, { payload: 1 });
  assert.equal(entry.lastOutputAt, firstAt);
  assert.equal(entry.lastOutputSeenAt, firstAt + 200);
  assert.equal(entry.outputCount, 3);
  assert.equal(entry.outputSkipped, 2);
  assert.equal(api.getStats().captures, 1);
  assert.equal(api.getStats().skippedByInterval, 2);

  // The input direction of the same node is limited independently.
  api._hooks.onReceive(receiveEvent('n1', { payload: 'in' }));
  entry = api.getLastMessageForNode('n1');
  assert.deepEqual(entry.lastInput, { payload: 'in' });

  advance(100); // 300 ms since the first output capture
  api._hooks.onSend(sendEvents('n1', { payload: 4 }));
  entry = api.getLastMessageForNode('n1');
  assert.deepEqual(entry.lastOutput, { payload: 4 });
  assert.equal(entry.outputSkipped, 0);
  assert.equal(entry.outputCount, 4);
  api.stop();
});

test('captureInterval 0 captures every message and changing it resets pending deadlines', () => {
  const { api } = makeInstance();
  api._hooks.onSend(sendEvents('n1', { payload: 1 }));
  api._hooks.onSend(sendEvents('n1', { payload: 2 }));
  assert.deepEqual(api.getLastMessageForNode('n1').lastOutput, { payload: 1 });
  api.updateSettings({ captureInterval: 0 });
  api._hooks.onSend(sendEvents('n1', { payload: 3 }));
  api._hooks.onSend(sendEvents('n1', { payload: 4 }));
  assert.deepEqual(api.getLastMessageForNode('n1').lastOutput, { payload: 4 });
  assert.equal(api.getLastMessageForNode('n1').outputSkipped, 0);
  api.stop();
});

test('global CPU budget caps snapshot work per second across all nodes', () => {
  const { api, clock, advance } = makeInstance();
  api.updateSettings({ captureBudget: 5 });
  clock.hrStep = 3; // every capture "costs" 3 ms
  api._hooks.onReceive(receiveEvent('a', { payload: 'a' }));
  api._hooks.onReceive(receiveEvent('b', { payload: 'b' }));
  api._hooks.onReceive(receiveEvent('c', { payload: 'c' }));
  assert.deepEqual(api.getLastMessageForNode('a').lastInput, { payload: 'a' });
  assert.deepEqual(api.getLastMessageForNode('b').lastInput, { payload: 'b' });
  assert.equal(api.getLastMessageForNode('c').lastInput, null);
  assert.equal(api.getLastMessageForNode('c').inputSkipped, 1);
  assert.equal(api.getLastMessageForNode('c').inputCount, 1);
  const stats = api.getStats();
  assert.equal(stats.skippedByBudget, 1);
  assert.equal(stats.captures, 2);
  assert.equal(stats.captureMs, 6);
  assert.equal(stats.maxCaptureMs, 3);

  advance(1000); // new budget window ('c' was never captured, so no backoff applies)
  api._hooks.onReceive(receiveEvent('c', { payload: 'c2' }));
  assert.deepEqual(api.getLastMessageForNode('c').lastInput, { payload: 'c2' });
  assert.equal(api.getLastMessageForNode('c').inputSkipped, 0);

  api.updateSettings({ captureBudget: 0 }); // unlimited
  api._hooks.onReceive(receiveEvent('d', { payload: 'd' }));
  api._hooks.onReceive(receiveEvent('e', { payload: 'e' }));
  api._hooks.onReceive(receiveEvent('f', { payload: 'f' }));
  assert.deepEqual(api.getLastMessageForNode('f').lastInput, { payload: 'f' });
  api.stop();
});

test('multi-wire sends record one output snapshot per send call', () => {
  const { api } = makeInstance();
  const msg = { payload: 'fan-out' };
  const events = [...sendEvents('n1', msg, 'a'), ...sendEvents('n1', msg, 'b'), ...sendEvents('n1', msg, 'c')];
  api._hooks.onSend(events);
  const entry = api.getLastMessageForNode('n1');
  assert.equal(entry.outputCount, 1);
  assert.equal(api.getStats().captures, 1);
  assert.deepEqual(entry.lastOutput, { payload: 'fan-out' });
  api.stop();
});

test('disabling clears snapshots and enabling repopulates node metadata from the flow config', () => {
  const configNodes = [
    { id: 'tab1', type: 'tab', label: 'x' },
    { id: 'n1', type: 'function', name: 'One', z: 'tab1' },
    { id: 'n2', type: 'debug', name: '', z: 'tab1' },
  ];
  const { RED, api } = makeInstance({ configNodes });
  assert.equal(api.getLastMessages().length, 2, 'entries pre-created from config, tabs skipped');
  api._hooks.onSend(sendEvents('n1', { payload: 1 }));
  api.updateSettings({ enabled: false });
  assert.deepEqual(api.getLastMessages(), []);
  let called = false;
  RED.hooks.trigger('onSend', sendEvents('n1', { payload: 2 }), () => { called = true; });
  assert.ok(called);
  assert.deepEqual(api.getLastMessages(), []);
  api.updateSettings({ enabled: true });
  const names = api.getLastMessages().map((e) => `${e.id}:${e.type}:${e.name}`).sort();
  assert.deepEqual(names, ['n1:function:One', 'n2:debug:']);
  api.stop();
});

test('flows:started prunes entries for nodes that no longer exist and refreshes metadata', () => {
  const configNodes = [{ id: 'n1', type: 'function', name: 'Old name' }];
  const { RED, api } = makeInstance({ configNodes });
  api._hooks.onSend(sendEvents('ghost', { payload: 1 }));
  assert.ok(api.getLastMessageForNode('ghost'));
  configNodes[0].name = 'New name';
  configNodes.push({ id: 'g1', type: 'group' }, { id: 'sf', type: 'subflow' }, { id: 'n3', type: 'inject', name: 'I' });
  RED.events.emit('flows:started', {});
  assert.equal(api.getLastMessageForNode('ghost'), null);
  assert.equal(api.getLastMessageForNode('n1').name, 'New name');
  assert.equal(api.getLastMessageForNode('g1'), null);
  assert.equal(api.getLastMessageForNode('n3').type, 'inject');
  api.stop();
  assert.equal(RED.events.listenerCount('flows:started'), 0);
});

test('reads its configuration from settings.js under either package name', () => {
  const settingsObject = {
    plugins: {
      '@rosepetal/node-red-contrib-message-control': {
        enabled: false,
        captureInterval: 1000,
        captureBudget: 2,
        snapshotLimits: { maxValues: 25, maxDepth: 2, bogus: 'ignored' },
      },
    },
  };
  const a = makeInstance({ settings: settingsObject });
  assert.equal(a.RED.hooks.has(ON_SEND), false, 'enabled:false must not install hooks');
  assert.deepEqual(a.api.getSettings(), { enabled: false, captureInterval: 1000, captureBudget: 2 });
  assert.equal(a.api.getStats().limits.maxValues, 25);
  assert.equal(a.api.getStats().limits.maxDepth, 2);
  assert.equal(a.api.getStats().limits.maxArrayLength, DEFAULT_LIMITS.maxArrayLength);
  a.api.stop();

  const b = makeInstance({
    settings: {
      get(key) {
        return key === 'plugins' ? { 'node-red-contrib-message-control': { captureEnabled: true, enabled: false } } : undefined;
      },
    },
  });
  assert.ok(b.RED.hooks.has(ON_SEND), 'captureEnabled takes precedence over enabled');
  b.api.stop();
});

test('validates runtime setting updates', () => {
  const { api } = makeInstance();
  assert.deepEqual(api.updateSettings({ captureInterval: -5, captureBudget: 'nope', enabled: 'yes' }), {
    enabled: true, captureInterval: 250, captureBudget: 5,
  });
  assert.deepEqual(api.updateSettings({ captureInterval: '500', captureBudget: 20 }), {
    enabled: true, captureInterval: 500, captureBudget: 20,
  });
  assert.equal(api.updateSettings({ captureInterval: 1e12 }).captureInterval, 3600000);
  assert.equal(api.updateSettings({ captureBudget: 5000 }).captureBudget, 1000);
  assert.deepEqual(api.updateSettings(null).enabled, true);
  api.stop();
});

test('HTTP endpoints expose summaries, snapshots, settings and stats', async () => {
  const { RED, api } = makeInstance();
  api._hooks.onSend(sendEvents('n1', { payload: 'out' }));
  api._hooks.onReceive(receiveEvent('n1', { payload: 'in' }));

  let res = fakeRes();
  findRoute(RED, 'get', '/nodes')({}, res);
  assert.equal(res.body.length, 1);
  assert.deepEqual(Object.keys(res.body[0]).sort(), [
    'id', 'inputCount', 'lastInputAt', 'lastInputSeenAt', 'lastOutputAt', 'lastOutputSeenAt', 'name', 'outputCount', 'type',
  ]);

  res = fakeRes();
  findRoute(RED, 'get', '/nodes/:id')({ params: { id: 'missing' } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'unknown_node');

  res = fakeRes();
  findRoute(RED, 'get', '/nodes/:id')({ params: { id: 'n1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.lastInput, { payload: 'in' });
  assert.deepEqual(res.body.lastOutput, { payload: 'out' });
  assert.equal('nextInputCaptureAt' in res.body, false);

  res = fakeRes();
  findRoute(RED, 'get', '/settings')({}, res);
  assert.deepEqual(res.body, { enabled: true, captureInterval: 250, captureBudget: 5 });

  res = fakeRes();
  findRoute(RED, 'get', '/stats')({}, res);
  assert.equal(res.body.captures, 2);
  assert.equal(res.body.nodes, 1);
  assert.equal(res.body.hooksInstalled, true);

  const post = findRoute(RED, 'post', '/settings');
  res = fakeRes();
  post({ body: { enabled: false, captureInterval: 100 } }, res);
  await res.finished;
  assert.deepEqual(res.body, { enabled: false, captureInterval: 100, captureBudget: 5 });
  assert.equal(RED.hooks.has(ON_SEND), false);

  res = fakeRes();
  post({ body: { captureInterval: -1 } }, res);
  await res.finished;
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'invalid_request');

  res = fakeRes();
  post({ body: { unrelated: true } }, res);
  await res.finished;
  assert.equal(res.statusCode, 400);

  // Raw request stream without a body parser.
  const stream = new PassThrough();
  res = fakeRes();
  post(stream, res);
  stream.end('{"enabled": true}');
  await res.finished;
  assert.equal(res.body.enabled, true);
  assert.ok(RED.hooks.has(ON_SEND));

  const broken = new PassThrough();
  res = fakeRes();
  post(broken, res);
  broken.end('{not json');
  await res.finished;
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'invalid_json');

  const huge = new PassThrough();
  res = fakeRes();
  post(huge, res);
  huge.write(Buffer.alloc(1024 * 1024 + 1, 32));
  await res.finished;
  assert.equal(res.statusCode, 413);
  api.stop();
});

test('plugin entry point is a singleton until stopped', () => {
  const RED1 = createMockRED();
  const first = plugin(RED1, { disableClockTimer: true });
  assert.equal(plugin(createMockRED()), first);
  first.stop();
  const RED2 = createMockRED();
  const second = plugin(RED2, { disableClockTimer: true });
  assert.notEqual(second, first);
  assert.ok(RED2.hooks.has(ON_SEND));
  second.stop();
});

test('the coarse clock timer never keeps the process alive and stops with the hooks', () => {
  const countRefTimers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const RED = createMockRED();
  const before = countRefTimers();
  const api = plugin.create(RED);
  assert.equal(api.getStats().clockRunning, true);
  assert.equal(countRefTimers(), before, 'the clock timer is unref()ed so it never holds the event loop open');
  api.updateSettings({ enabled: false });
  assert.equal(api.getStats().clockRunning, false);
  api.updateSettings({ enabled: true });
  assert.equal(api.getStats().clockRunning, true);
  api.stop();
  assert.equal(api.getStats().clockRunning, false);
});

// ---------------------------------------------------------------------------
// Against the real @node-red/util hooks engine (skipped when unavailable)
// ---------------------------------------------------------------------------

function resolveRealHooks() {
  const nodeRedPath = findNodeRed();
  if (!nodeRedPath) {
    return null;
  }
  const candidate = path.join(nodeRedPath, 'node_modules', '@node-red', 'util', 'lib', 'hooks.js');
  return fs.existsSync(candidate) ? candidate : null;
}

const realHooksPath = resolveRealHooks();

test('real Node-RED hooks engine: message delivery continues even for hostile messages', { skip: !realHooksPath && 'node-red not installed' }, () => {
  const hooks = require(realHooksPath);
  const RED = createMockRED();
  RED.hooks = hooks;
  const api = plugin.create(RED, { disableClockTimer: true });
  try {
    assert.ok(hooks.has(ON_SEND));
    assert.ok(hooks.has(ON_RECEIVE));
    const outcomes = [];
    hooks.trigger('onReceive', { msg: throwingProxy(), destination: { id: 'x', node: null } }, (err) => outcomes.push(err));
    hooks.trigger('onReceive', throwingProxy(), (err) => outcomes.push(err));
    hooks.trigger('onSend', sendEvents('n1', throwingProxy()), (err) => outcomes.push(err));
    hooks.trigger('onSend', throwingProxy(), (err) => outcomes.push(err));
    assert.deepEqual(outcomes, [undefined, undefined, undefined, undefined]);
    assert.equal(api.getStats().errors, 1, 'a hostile receive event is counted; hostile messages are snapshotted as unreadable');
    api.updateSettings({ enabled: false });
    assert.equal(hooks.has(ON_SEND), false);
    assert.equal(hooks.has(ON_RECEIVE), false);
  } finally {
    api.stop();
    try {
      hooks.remove(`*.${HOOK_NAMESPACE}`);
    } catch (err) {
      // already removed
    }
  }
});
