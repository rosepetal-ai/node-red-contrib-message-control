'use strict';

/*
 * rosepetal-message-control runtime plugin.
 *
 * Design goals (in priority order):
 *   1. Never interfere with message delivery. The hooks are synchronous
 *      one-argument handlers (the cheapest kind Node-RED supports), they never
 *      return a value and they never let an exception escape, so Node-RED can
 *      never halt or error a message because of this plugin.
 *   2. Cost nothing when disabled: the hooks are removed from the router.
 *   3. Cost a constant few hundred nanoseconds per message when enabled: the
 *      hook only touches a Map entry, a counter and two timestamps.
 *   4. Bound the snapshot work strictly: no deep clone, no JSON.stringify, a
 *      walk with hard limits (values, depth, keys, items, characters), rate
 *      limited per node and capped by a global CPU budget.
 */

const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');

const HOOK_NAMESPACE = 'rosepetal-message-control';
const SETTINGS_KEYS = ['@rosepetal/node-red-contrib-message-control', 'node-red-contrib-message-control'];
const MAX_SETTINGS_BODY_SIZE = 1024 * 1024; // 1 MB limit for settings payloads
const BUDGET_WINDOW_MS = 1000;
const ERROR_LOG_INTERVAL_MS = 60000;
const MAX_CAPTURE_INTERVAL_MS = 3600000;
const MAX_CAPTURE_BUDGET_MS = BUDGET_WINDOW_MS;
// The hooks never read the system clock (Date.now() can cost >1 µs on VMs
// and sandboxes). A coarse clock is refreshed by an unref'd timer instead.
const CLOCK_TICK_MS = 50;
// Enumerating the keys of a huge dictionary is O(n) in V8 no matter how few
// keys are read, so a capture can occasionally be slow. A node whose capture
// exceeded SLOW_CAPTURE_MS is not sampled again for SLOW_CAPTURE_BACKOFF_MS.
const SLOW_CAPTURE_MS = 2;
const SLOW_CAPTURE_BACKOFF_MS = 10000;

const CLEAN_TRUNCATED_FLAG = '__rosepetalCleanTruncated';
const CLEAN_NOTE_KEY = '__rosepetalCleanNote';
const TRUNCATED_MARKER = '[… truncated]';
const BASE64_PROBE_LENGTH = 512;

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  // Minimum gap (ms) between two snapshots of the same node and direction.
  // 0 captures every message (each capture is still strictly bounded).
  captureInterval: 250,
  // Global cap: milliseconds of snapshot CPU allowed per second across all
  // nodes (5 => at most 0.5 % of one core). 0 disables the cap.
  captureBudget: 5,
});

const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 6,
  maxArrayLength: 50,
  maxObjectKeys: 60,
  maxStringLength: 2048,
  // Hard cap on values visited per snapshot (bounds CPU per capture).
  maxValues: 2000,
  // Hard cap on string characters kept per snapshot (bounds memory).
  maxChars: 262144,
});

const hasOwn = Object.prototype.hasOwnProperty;

// ---------------------------------------------------------------------------
// Snapshot walker (bounded, allocation-light, never throws)
// ---------------------------------------------------------------------------

function placeholder(type, detail) {
  return `[${type} withheld: ${detail}]`;
}

function constructorName(value) {
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto === null) {
      return null;
    }
    const ctor = proto.constructor;
    return ctor && typeof ctor.name === 'string' && ctor.name ? ctor.name : null;
  } catch (err) {
    return null;
  }
}

function looksLikeDataImage(value) {
  // Equivalent to value.trim().startsWith('data:image/') without copying.
  let i = 0;
  const len = value.length;
  while (i < len && i < 64) {
    const c = value.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13)) {
      i += 1;
    } else {
      break;
    }
  }
  return value.startsWith('data:image/', i);
}

function looksLikeBase64(value) {
  // Only inspects a fixed-size prefix so the cost is O(1) for any string size.
  // Requires the base64 alphabet (line breaks allowed) plus a mix of upper,
  // lower and digit characters so long plain words are not mistaken for it.
  if (value.length < BASE64_PROBE_LENGTH || value.length % 4 !== 0) {
    return false;
  }
  let upper = false;
  let lower = false;
  let digit = false;
  for (let i = 0; i < BASE64_PROBE_LENGTH; i += 1) {
    const c = value.charCodeAt(i);
    if (c >= 65 && c <= 90) {
      upper = true;
    } else if (c >= 97 && c <= 122) {
      lower = true;
    } else if (c >= 48 && c <= 57) {
      digit = true;
    } else if (c !== 43 && c !== 47 && c !== 61 && c !== 10 && c !== 13) { // + / = \n \r
      return false;
    }
  }
  return upper && lower && digit;
}

function sanitizeString(value, state) {
  const len = value.length;
  if (len >= BASE64_PROBE_LENGTH) {
    if (looksLikeDataImage(value)) {
      return placeholder('DataImage', `${len} chars`);
    }
    if (looksLikeBase64(value)) {
      return placeholder('Base64', `${len} chars`);
    }
  }
  const allowed = Math.min(state.limits.maxStringLength, state.chars);
  if (len <= allowed) {
    state.chars -= len;
    return value;
  }
  if (allowed <= 0) {
    return placeholder('String', `${len} chars`);
  }
  state.chars -= allowed;
  return `${value.slice(0, allowed)}… [truncated ${len - allowed} chars]`;
}

function countOwnKeys(value, cap) {
  let count = 0;
  for (const key in value) {
    if (hasOwn.call(value, key)) {
      count += 1;
      if (count >= cap) {
        return `${cap}+`;
      }
    }
  }
  return String(count);
}

function walkArray(value, depth, state) {
  const limit = Math.min(value.length, state.limits.maxArrayLength);
  const out = [];
  for (let i = 0; i < limit; i += 1) {
    if (state.values <= 0) {
      out.push(`… ${value.length - i} more items (truncated)`);
      return out;
    }
    out.push(walk(value[i], depth + 1, state));
  }
  if (value.length > limit) {
    out.push(`… ${value.length - limit} more items`);
  }
  return out;
}

function walkObject(value, depth, state) {
  const out = {};
  const maxKeys = state.limits.maxObjectKeys;
  let shown = 0;
  let hidden = 0;
  let hiddenCapped = false;
  for (const key in value) {
    if (!hasOwn.call(value, key)) {
      continue;
    }
    if (shown < maxKeys && state.values > 0) {
      let child;
      try {
        child = value[key];
      } catch (err) {
        child = `[Unreadable: ${err && err.message ? err.message : err}]`;
      }
      out[key] = walk(child, depth + 1, state);
      shown += 1;
    } else {
      hidden += 1;
      if (hidden >= 1000) {
        hiddenCapped = true;
        break;
      }
    }
  }
  if (hidden > 0) {
    out[CLEAN_TRUNCATED_FLAG] = true;
    out[CLEAN_NOTE_KEY] = `${hidden}${hiddenCapped ? '+' : ''} more keys not shown`;
  }
  if (shown === 0 && hidden === 0) {
    const name = constructorName(value);
    if (name && name !== 'Object') {
      return `[${name}]`;
    }
  }
  return out;
}

function walkSpecial(value, state) {
  // Returns undefined when `value` is an ordinary object that should be walked.
  if (Buffer.isBuffer(value)) {
    return placeholder('Buffer', `${value.length} bytes`);
  }
  if (ArrayBuffer.isView(value)) {
    const name = constructorName(value) || 'TypedArray';
    return value instanceof DataView
      ? placeholder(name, `${value.byteLength} bytes`)
      : placeholder(name, `${value.length} items`);
  }
  if (value instanceof ArrayBuffer) {
    return placeholder('ArrayBuffer', `${value.byteLength} bytes`);
  }
  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
    return placeholder('SharedArrayBuffer', `${value.byteLength} bytes`);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (value instanceof RegExp) {
    return String(value);
  }
  if (value instanceof Error) {
    return { name: value.name, message: sanitizeString(String(value.message), state) };
  }
  if (value instanceof EventEmitter || (typeof value.on === 'function' && typeof value.emit === 'function')) {
    // Streams, sockets, HTTP req/res, database handles… never walk these.
    return placeholder(constructorName(value) || 'EventEmitter', 'event emitter');
  }
  if (typeof value.then === 'function') {
    return `[${constructorName(value) || 'Promise'}]`;
  }
  if (value instanceof Map || value instanceof Set) {
    return placeholder(constructorName(value) || 'Map', `${value.size} entries`);
  }
  if (value instanceof WeakMap || value instanceof WeakSet || (typeof WeakRef === 'function' && value instanceof WeakRef)) {
    return `[${constructorName(value)}]`;
  }
  return undefined;
}

function walkComplex(value, depth, state) {
  try {
    const isArray = Array.isArray(value);
    if (!isArray) {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        const special = walkSpecial(value, state);
        if (special !== undefined) {
          return special;
        }
      }
      if (value.type === 'Buffer' && Array.isArray(value.data)) {
        return placeholder('Buffer', `${value.data.length} bytes`);
      }
    }
    if (state.stack.indexOf(value) !== -1) {
      return '[Circular]';
    }
    if (depth >= state.limits.maxDepth) {
      return isArray ? `[Array(${value.length})]` : `[Object with ${countOwnKeys(value, 1000)} keys]`;
    }
    state.stack.push(value);
    try {
      return isArray ? walkArray(value, depth, state) : walkObject(value, depth, state);
    } finally {
      state.stack.pop();
    }
  } catch (err) {
    return `[Unreadable: ${err && err.message ? err.message : err}]`;
  }
}

function walk(value, depth, state) {
  if (value === null) {
    return null;
  }
  const type = typeof value;
  if (type === 'undefined') {
    return undefined;
  }
  if (state.values <= 0) {
    return TRUNCATED_MARKER;
  }
  state.values -= 1;
  switch (type) {
    case 'string':
      return sanitizeString(value, state);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return `${value.toString()}n`;
    case 'function':
      return `[Function ${value.name || 'anonymous'}]`;
    case 'symbol':
      return value.toString();
    default:
      return walkComplex(value, depth, state);
  }
}

/**
 * Produce a bounded, JSON-safe copy of a message. Never throws and never
 * mutates the input. Work is capped by `limits.maxValues`, memory by
 * `limits.maxChars`, independently of the size of the message.
 */
function snapshotMessage(value, limits = DEFAULT_LIMITS) {
  const state = {
    limits,
    values: limits.maxValues,
    chars: limits.maxChars,
    stack: [],
  };
  try {
    return walk(value, 0, state);
  } catch (err) {
    return { $$error: 'Unable to snapshot message', message: err && err.message ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers (admin API only – never on the message path)
// ---------------------------------------------------------------------------

function noopMiddleware(req, res, next) {
  next();
}

function makePermissionMiddleware(RED, permission) {
  if (RED.auth && typeof RED.auth.needsPermission === 'function') {
    return RED.auth.needsPermission(permission);
  }
  return noopMiddleware;
}

function createBodyParseError(code, message, status = 400) {
  const err = new Error(message || 'Invalid request');
  err.code = code || 'invalid_request';
  err.status = status;
  return err;
}

function ensureJsonBody(req, limit = MAX_SETTINGS_BODY_SIZE) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body);
  }
  if (req._rosepetalBodyPromise) {
    return req._rosepetalBodyPromise;
  }

  req._rosepetalBodyPromise = new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;
    let finished = false;

    function cleanup() {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('close', onClose);
    }

    function fail(code, message, status) {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      reject(createBodyParseError(code, message, status));
    }

    function onData(chunk) {
      if (finished) {
        return;
      }
      totalLength += chunk.length;
      if (totalLength > limit) {
        fail('entity_too_large', `Request body exceeds ${limit} bytes`, 413);
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      if (!chunks.length) {
        req.body = {};
        resolve(req.body);
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        req.body = text ? JSON.parse(text) : {};
        resolve(req.body);
      } catch (err) {
        reject(createBodyParseError('invalid_json', err.message));
      }
    }

    function onError(err) {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      reject(err);
    }

    function onClose() {
      fail('request_aborted', 'Request closed before body was received', 400);
    }

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('close', onClose);
  }).finally(() => {
    req._rosepetalBodyPromise = null;
  });

  return req._rosepetalBodyPromise;
}

function readPluginConfiguration(RED) {
  if (!RED || !RED.settings) {
    return {};
  }
  let plugins;
  try {
    if (typeof RED.settings.get === 'function') {
      plugins = RED.settings.get('plugins');
    }
  } catch (err) {
    plugins = undefined;
  }
  if (!plugins || typeof plugins !== 'object') {
    plugins = RED.settings.plugins;
  }
  if (!plugins || typeof plugins !== 'object') {
    return {};
  }
  for (const key of SETTINGS_KEYS) {
    if (plugins[key] && typeof plugins[key] === 'object') {
      return plugins[key];
    }
  }
  return {};
}

function toNonNegativeNumber(value, max) {
  if (typeof value === 'string' && value.trim() !== '') {
    value = Number(value);
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.min(value, max);
}

// ---------------------------------------------------------------------------
// Instrumentation instance
// ---------------------------------------------------------------------------

function createInstrumentation(RED, options = {}) {
  if (!RED || !RED.nodes || typeof RED.nodes.eachNode !== 'function') {
    throw new Error('rosepetal-message-control: Unexpected RED runtime shape - unable to access runtime nodes');
  }
  if (!RED.hooks || typeof RED.hooks.add !== 'function' || typeof RED.hooks.remove !== 'function') {
    throw new Error('rosepetal-message-control: RED.hooks API not available');
  }

  const settings = { ...DEFAULT_SETTINGS };
  const limits = { ...DEFAULT_LIMITS };
  const entries = new Map();
  const stats = {
    startedAt: Date.now(),
    inputsSeen: 0,
    outputsSeen: 0,
    captures: 0,
    captureMs: 0,
    maxCaptureMs: 0,
    skippedByInterval: 0,
    skippedByBudget: 0,
    slowCaptures: 0,
    errors: 0,
  };

  // Injectable clocks (tests); production uses the real ones.
  const readClock = typeof options.now === 'function' ? options.now : Date.now;
  const readHighRes = typeof options.hrNow === 'function' ? options.hrNow : () => performance.now();

  let hooksInstalled = false;
  let budgetWindowStart = 0;
  let budgetUsedMs = 0;
  let lastErrorLogAt = 0;
  let flowsStartedHandler = null;
  let clockTimer = null;
  let coarseNow = readClock();

  function tickClock() {
    coarseNow = readClock();
  }

  function startClock() {
    tickClock();
    if (clockTimer || options.disableClockTimer) {
      return;
    }
    clockTimer = setInterval(tickClock, CLOCK_TICK_MS);
    if (clockTimer && typeof clockTimer.unref === 'function') {
      clockTimer.unref();
    }
  }

  function stopClock() {
    if (clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  }

  function noteError(err) {
    stats.errors += 1;
    const now = coarseNow;
    if (now - lastErrorLogAt < ERROR_LOG_INTERVAL_MS) {
      return;
    }
    lastErrorLogAt = now;
    if (RED.log && typeof RED.log.warn === 'function') {
      try {
        RED.log.warn(`rosepetal-message-control: snapshot hook error (${stats.errors} so far): ${err && err.message ? err.message : err}`);
      } catch (ignored) {
        // Logging must never break the message path either.
      }
    }
  }

  function createEntry(id, type, name) {
    // Keep a single property layout so V8 shares one hidden class.
    return {
      id,
      type: typeof type === 'string' ? type : '',
      name: typeof name === 'string' ? name : '',
      lastInput: null,
      lastInputAt: null,
      lastOutput: null,
      lastOutputAt: null,
      lastInputSeenAt: null,
      lastOutputSeenAt: null,
      inputCount: 0,
      outputCount: 0,
      inputSkipped: 0,
      outputSkipped: 0,
      nextInputCaptureAt: 0,
      nextOutputCaptureAt: 0,
    };
  }

  function getEntry(id, node) {
    let entry = entries.get(id);
    if (entry === undefined) {
      entry = createEntry(id, node ? node.type : '', node ? node.name : '');
      entries.set(id, entry);
    }
    return entry;
  }

  function toPublic(entry) {
    return {
      id: entry.id,
      type: entry.type,
      name: entry.name,
      lastInput: entry.lastInput,
      lastInputAt: entry.lastInputAt,
      lastOutput: entry.lastOutput,
      lastOutputAt: entry.lastOutputAt,
      lastInputSeenAt: entry.lastInputSeenAt,
      lastOutputSeenAt: entry.lastOutputSeenAt,
      inputCount: entry.inputCount,
      outputCount: entry.outputCount,
      inputSkipped: entry.inputSkipped,
      outputSkipped: entry.outputSkipped,
    };
  }

  function toSummary(entry) {
    return {
      id: entry.id,
      type: entry.type,
      name: entry.name,
      lastInputAt: entry.lastInputAt,
      lastOutputAt: entry.lastOutputAt,
      lastInputSeenAt: entry.lastInputSeenAt,
      lastOutputSeenAt: entry.lastOutputSeenAt,
      inputCount: entry.inputCount,
      outputCount: entry.outputCount,
    };
  }

  function budgetExhausted(now) {
    if (settings.captureBudget <= 0) {
      return false;
    }
    if (now - budgetWindowStart >= BUDGET_WINDOW_MS) {
      budgetWindowStart = now;
      budgetUsedMs = 0;
    }
    return budgetUsedMs >= settings.captureBudget;
  }

  function capture(entry, msg, isInput) {
    // Captures are rare (rate limited), so an exact timestamp is affordable here.
    tickClock();
    const now = coarseNow;
    if (budgetExhausted(now)) {
      if (isInput) {
        entry.inputSkipped += 1;
      } else {
        entry.outputSkipped += 1;
      }
      stats.skippedByBudget += 1;
      return;
    }
    const started = readHighRes();
    const snapshot = snapshotMessage(msg, limits);
    const elapsed = readHighRes() - started;
    budgetUsedMs += elapsed;
    stats.captures += 1;
    stats.captureMs += elapsed;
    if (elapsed > stats.maxCaptureMs) {
      stats.maxCaptureMs = elapsed;
    }
    let interval = settings.captureInterval;
    if (elapsed > SLOW_CAPTURE_MS) {
      stats.slowCaptures += 1;
      interval = Math.max(interval, SLOW_CAPTURE_BACKOFF_MS);
    }
    const next = interval > 0 ? now + interval : 0;
    if (isInput) {
      entry.lastInput = snapshot;
      entry.lastInputAt = now;
      entry.lastInputSeenAt = now;
      entry.inputSkipped = 0;
      entry.nextInputCaptureAt = next;
    } else {
      entry.lastOutput = snapshot;
      entry.lastOutputAt = now;
      entry.lastOutputSeenAt = now;
      entry.outputSkipped = 0;
      entry.nextOutputCaptureAt = next;
    }
  }

  // onSend hook: one-argument => Node-RED runs it synchronously and inline.
  // It must never return a value (`false` would halt the flow) and never throw.
  function onSend(events) {
    try {
      if (!Array.isArray(events)) {
        return;
      }
      let msg = null;
      let source = null;
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const ev = events[i];
        if (ev && ev.msg && ev.source && ev.source.id) {
          msg = ev.msg;
          source = ev.source;
          break;
        }
      }
      if (msg === null) {
        return;
      }
      const entry = getEntry(source.id, source.node);
      entry.outputCount += 1;
      entry.lastOutputSeenAt = coarseNow;
      stats.outputsSeen += 1;
      if (coarseNow < entry.nextOutputCaptureAt) {
        entry.outputSkipped += 1;
        stats.skippedByInterval += 1;
        return;
      }
      capture(entry, msg, false);
    } catch (err) {
      noteError(err);
    }
  }

  function onReceive(event) {
    try {
      if (!event || !event.msg || !event.destination || !event.destination.id) {
        return;
      }
      const entry = getEntry(event.destination.id, event.destination.node);
      entry.inputCount += 1;
      entry.lastInputSeenAt = coarseNow;
      stats.inputsSeen += 1;
      if (coarseNow < entry.nextInputCaptureAt) {
        entry.inputSkipped += 1;
        stats.skippedByInterval += 1;
        return;
      }
      capture(entry, event.msg, true);
    } catch (err) {
      noteError(err);
    }
  }

  function installHooks() {
    if (hooksInstalled) {
      return;
    }
    RED.hooks.add(`onSend.${HOOK_NAMESPACE}`, onSend);
    try {
      RED.hooks.add(`onReceive.${HOOK_NAMESPACE}`, onReceive);
    } catch (err) {
      RED.hooks.remove(`onSend.${HOOK_NAMESPACE}`);
      throw err;
    }
    hooksInstalled = true;
    startClock();
  }

  function removeHooks() {
    if (!hooksInstalled) {
      return;
    }
    hooksInstalled = false;
    stopClock();
    for (const hookId of [`onSend.${HOOK_NAMESPACE}`, `onReceive.${HOOK_NAMESPACE}`]) {
      try {
        RED.hooks.remove(hookId);
      } catch (err) {
        // ignore removal errors
      }
    }
  }

  function refreshNodeMetadata() {
    const activeIds = new Set();
    try {
      RED.nodes.eachNode(function (n) {
        if (!n || !n.id) {
          return;
        }
        if (n.type === 'tab' || n.type === 'group' || n.type === 'subflow') {
          return;
        }
        activeIds.add(n.id);
        const entry = getEntry(n.id, n);
        if (typeof n.type === 'string') {
          entry.type = n.type;
        }
        if (typeof n.name === 'string') {
          entry.name = n.name;
        }
      });
    } catch (err) {
      // Runtime may not have loaded flows yet; retry on next flows:started event
      return;
    }
    for (const id of entries.keys()) {
      if (!activeIds.has(id)) {
        entries.delete(id);
      }
    }
  }

  function getSettings() {
    return { ...settings };
  }

  function getStats() {
    const now = readClock();
    return {
      enabled: settings.enabled,
      hooksInstalled,
      clockRunning: clockTimer !== null,
      uptimeMs: now - stats.startedAt,
      nodes: entries.size,
      inputsSeen: stats.inputsSeen,
      outputsSeen: stats.outputsSeen,
      captures: stats.captures,
      skippedByInterval: stats.skippedByInterval,
      skippedByBudget: stats.skippedByBudget,
      slowCaptures: stats.slowCaptures,
      captureMs: Math.round(stats.captureMs * 1000) / 1000,
      avgCaptureMs: stats.captures ? Math.round((stats.captureMs / stats.captures) * 1000) / 1000 : 0,
      maxCaptureMs: Math.round(stats.maxCaptureMs * 1000) / 1000,
      errors: stats.errors,
      limits: { ...limits },
    };
  }

  function applySettings(update = {}, options = {}) {
    if (!update || typeof update !== 'object') {
      return getSettings();
    }
    let interval = null;
    let budget = null;
    let enabled = null;
    if (hasOwn.call(update, 'captureInterval')) {
      interval = toNonNegativeNumber(update.captureInterval, MAX_CAPTURE_INTERVAL_MS);
    }
    if (hasOwn.call(update, 'captureBudget')) {
      budget = toNonNegativeNumber(update.captureBudget, MAX_CAPTURE_BUDGET_MS);
    }
    if (hasOwn.call(update, 'enabled') && typeof update.enabled === 'boolean') {
      enabled = update.enabled;
    }
    if (interval !== null && interval !== settings.captureInterval) {
      settings.captureInterval = interval;
      // Deadlines computed with the previous interval must not linger.
      for (const entry of entries.values()) {
        entry.nextInputCaptureAt = 0;
        entry.nextOutputCaptureAt = 0;
      }
    }
    if (budget !== null) {
      settings.captureBudget = budget;
    }
    if (enabled !== null && enabled !== settings.enabled) {
      settings.enabled = enabled;
      if (enabled) {
        installHooks();
        if (!options.skipMetadataRefresh) {
          refreshNodeMetadata();
        }
      } else {
        removeHooks();
        entries.clear();
      }
    }
    return getSettings();
  }

  function applyLimits(update) {
    if (!update || typeof update !== 'object') {
      return;
    }
    for (const key of Object.keys(DEFAULT_LIMITS)) {
      const value = toNonNegativeNumber(update[key], Number.MAX_SAFE_INTEGER);
      if (value !== null) {
        limits[key] = Math.floor(value);
      }
    }
  }

  function initializeFromSettings() {
    const configured = readPluginConfiguration(RED);
    const initial = {};
    if (typeof configured.captureEnabled === 'boolean') {
      initial.enabled = configured.captureEnabled;
    } else if (typeof configured.enabled === 'boolean') {
      initial.enabled = configured.enabled;
    }
    if (hasOwn.call(configured, 'captureInterval')) {
      initial.captureInterval = configured.captureInterval;
    }
    if (hasOwn.call(configured, 'captureBudget')) {
      initial.captureBudget = configured.captureBudget;
    }
    applyLimits(configured.snapshotLimits);
    // Apply the numeric settings first, then decide whether to install hooks.
    const enabled = hasOwn.call(initial, 'enabled') ? initial.enabled : DEFAULT_SETTINGS.enabled;
    delete initial.enabled;
    applySettings(initial, { skipMetadataRefresh: true });
    settings.enabled = enabled;
    if (enabled) {
      installHooks();
    }
  }

  function registerHttpEndpoints() {
    if (!RED.httpAdmin || typeof RED.httpAdmin.get !== 'function') {
      return;
    }
    const readPermission = makePermissionMiddleware(RED, 'flows.read');
    const writePermission = makePermissionMiddleware(RED, 'flows.write');
    const basePath = '/rosepetal/message-control';

    RED.httpAdmin.get(`${basePath}/nodes`, readPermission, function (req, res) {
      const response = [];
      for (const entry of entries.values()) {
        response.push(toSummary(entry));
      }
      res.json(response);
    });

    RED.httpAdmin.get(`${basePath}/nodes/:id`, readPermission, function (req, res) {
      const entry = entries.get(req.params.id);
      if (!entry) {
        res.status(404).json({ error: 'unknown_node', message: `No messages recorded for node ${req.params.id}` });
        return;
      }
      res.json(toPublic(entry));
    });

    RED.httpAdmin.get(`${basePath}/settings`, readPermission, function (req, res) {
      res.json(getSettings());
    });

    RED.httpAdmin.get(`${basePath}/stats`, readPermission, function (req, res) {
      res.json(getStats());
    });

    RED.httpAdmin.post(`${basePath}/settings`, writePermission, function (req, res) {
      ensureJsonBody(req)
        .then((body) => {
          const source = body || {};
          const update = {};
          if (hasOwn.call(source, 'enabled')) {
            update.enabled = !!source.enabled;
          }
          if (hasOwn.call(source, 'captureInterval')) {
            if (toNonNegativeNumber(source.captureInterval, MAX_CAPTURE_INTERVAL_MS) === null) {
              res.status(400).json({ error: 'invalid_request', message: 'captureInterval must be a non-negative number of milliseconds' });
              return;
            }
            update.captureInterval = source.captureInterval;
          }
          if (hasOwn.call(source, 'captureBudget')) {
            if (toNonNegativeNumber(source.captureBudget, MAX_CAPTURE_BUDGET_MS) === null) {
              res.status(400).json({ error: 'invalid_request', message: 'captureBudget must be a non-negative number of milliseconds per second' });
              return;
            }
            update.captureBudget = source.captureBudget;
          }
          if (!Object.keys(update).length) {
            res.status(400).json({ error: 'invalid_request', message: 'No valid setting provided' });
            return;
          }
          res.json(applySettings(update));
        })
        .catch((err) => {
          const status = err && err.status ? err.status : 400;
          res.status(status).json({
            error: (err && err.code) || 'invalid_request',
            message: err && err.message ? err.message : 'Unable to parse request body',
          });
        });
    });
  }

  // --- bootstrap -----------------------------------------------------------

  initializeFromSettings();
  registerHttpEndpoints();
  refreshNodeMetadata();

  if (RED.events && typeof RED.events.on === 'function') {
    flowsStartedHandler = function handleFlowsStarted() {
      refreshNodeMetadata();
    };
    RED.events.on('flows:started', flowsStartedHandler);
  }

  if (RED.log && typeof RED.log.info === 'function') {
    RED.log.info(`rosepetal-message-control: snapshot instrumentation loaded (enabled=${settings.enabled}, captureInterval=${settings.captureInterval}ms, captureBudget=${settings.captureBudget}ms/s)`);
  }

  return {
    getLastMessages() {
      const out = [];
      for (const entry of entries.values()) {
        out.push(toPublic(entry));
      }
      return out;
    },
    getLastMessageForNode(id) {
      const entry = entries.get(id);
      return entry ? toPublic(entry) : null;
    },
    getSettings,
    getStats,
    updateSettings(patch) {
      return applySettings(patch);
    },
    clear(id) {
      if (id) {
        entries.delete(id);
      } else {
        entries.clear();
      }
    },
    refresh: refreshNodeMetadata,
    stop() {
      removeHooks();
      stopClock();
      if (flowsStartedHandler && RED.events && typeof RED.events.removeListener === 'function') {
        RED.events.removeListener('flows:started', flowsStartedHandler);
        flowsStartedHandler = null;
      }
      entries.clear();
    },
    // Exposed for tests: the raw hook handlers and a manual clock refresh.
    _hooks: { onSend, onReceive },
    _tick: tickClock,
  };
}

// ---------------------------------------------------------------------------
// Node-RED plugin entry point
// ---------------------------------------------------------------------------

let active = null;

function register(RED, options) {
  if (active) {
    return active;
  }
  const instance = createInstrumentation(RED, options);
  const originalStop = instance.stop;
  instance.stop = function stop() {
    originalStop();
    if (active === instance) {
      active = null;
    }
  };
  active = instance;
  return instance;
}

module.exports = register;
module.exports.create = createInstrumentation;
module.exports.snapshotMessage = snapshotMessage;
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
module.exports.DEFAULT_LIMITS = DEFAULT_LIMITS;
module.exports.HOOK_NAMESPACE = HOOK_NAMESPACE;
