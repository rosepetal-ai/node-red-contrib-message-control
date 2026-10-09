'use strict';

/*
 * Runtime log buffer: the last N entries of Node-RED's log (RED.log
 * handler), structured, filterable over HTTP. Node construction errors only
 * ever reach the log, so this is the place to look for them.
 *
 * Non-blocking: the handler does O(1) work per log entry (one slot of a
 * fixed ring, text bounded to maxText characters through a bounded
 * serializer) and never throws; queries scan at most the ring size.
 */

const { EventEmitter } = require('events');

const LEVELS = { fatal: 10, error: 20, warn: 30, info: 40, debug: 50, trace: 60 };
const NAMES = { 10: 'fatal', 20: 'error', 30: 'warn', 40: 'info', 50: 'debug', 60: 'trace', 98: 'audit', 99: 'metric' };

// Errors created in another realm (a function node's vm sandbox) are not
// `instanceof Error` in the runtime: recognise them by their tag.
function isError(value) {
  return value instanceof Error || Object.prototype.toString.call(value) === '[object Error]';
}

function levelValue(name, fallback) {
  if (typeof name === 'number') return name;
  return LEVELS[String(name || '').toLowerCase()] || fallback;
}

/**
 * @param {Object} RED
 * @param {{size?: number, level?: string, maxText?: number, serialize?: Function}} options
 */
function createLogBuffer(RED, options = {}) {
  const size = Math.max(0, Math.floor(options.size ?? 2000));
  const maxText = Math.max(200, Math.floor(options.maxText ?? 2000));
  const serialize = typeof options.serialize === 'function' ? options.serialize : (v) => String(v);
  let captureLevel = levelValue(options.level, LEVELS.info);
  const ring = new Array(size);
  let start = 0;
  let count = 0;
  let seq = 0;
  let dropped = 0;
  let installed = false;

  function toText(value) {
    let text;
    try {
      if (typeof value === 'string') text = value;
      else if (isError(value)) {
        text = `${value.name || 'Error'}: ${value.message}`;
        const frame = typeof value.stack === 'string' ? value.stack.split('\n')[1] : null;
        if (frame) text += ` (${frame.trim()})`;
      } else if (value === undefined || value === null) text = String(value);
      else if (typeof value === 'object') text = JSON.stringify(serialize(value));
      else text = String(value);
    } catch (err) {
      text = `[unprintable log entry: ${err && err.message}]`;
    }
    return text.length > maxText ? `${text.slice(0, maxText)}… [truncated ${text.length - maxText} chars]` : text;
  }

  const handler = new EventEmitter();
  handler.on('log', (msg) => {
    try {
      if (!msg || typeof msg.level !== 'number' || msg.level > captureLevel || size === 0) return;
      const entry = {
        seq: ++seq,
        at: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
        level: NAMES[msg.level] || String(msg.level),
        id: typeof msg.id === 'string' ? msg.id : undefined,
        type: typeof msg.type === 'string' ? msg.type : undefined,
        name: typeof msg.name === 'string' && msg.name ? msg.name : undefined,
        z: typeof msg.z === 'string' ? msg.z : undefined,
        text: toText(msg.msg)
      };
      if (count < size) {
        ring[(start + count) % size] = entry;
        count += 1;
      } else {
        ring[start] = entry;
        start = (start + 1) % size;
        dropped += 1;
      }
    } catch (err) {
      // a log handler must never break the logger
    }
  });

  function install() {
    if (installed || size === 0 || !RED.log || typeof RED.log.addHandler !== 'function') return;
    RED.log.addHandler(handler);
    installed = true;
  }

  function uninstall() {
    if (!installed) return;
    try {
      RED.log.removeHandler(handler);
    } catch (err) {
      // ignore
    }
    installed = false;
  }

  /**
   * Matching entries, oldest first, the newest `limit` of them.
   * @param {Object} q - {since, until, level, text, node, type, limit}
   *   (plain substring match only: a caller-supplied regex could hang the
   *   runtime with catastrophic backtracking)
   */
  function query(q = {}) {
    const maxLevel = levelValue(q.level, LEVELS.trace);
    const since = Number.isFinite(Number(q.since)) ? Number(q.since) : null;
    const until = Number.isFinite(Number(q.until)) ? Number(q.until) : null;
    const limit = Math.max(1, Math.min(1000, Math.floor(Number(q.limit) || 200)));
    const text = typeof q.text === 'string' && q.text ? q.text.toLowerCase() : null;
    const out = [];
    let matched = 0;
    for (let i = count - 1; i >= 0; i -= 1) {
      const e = ring[(start + i) % size];
      if (since !== null && e.at < since) break;
      if (until !== null && e.at > until) continue;
      if (LEVELS[e.level] !== undefined && LEVELS[e.level] > maxLevel) continue;
      if (q.node && e.id !== q.node) continue;
      if (q.type && e.type !== q.type) continue;
      if (text && !e.text.toLowerCase().includes(text) && !(e.name || '').toLowerCase().includes(text) && !(e.type || '').toLowerCase().includes(text)) continue;
      matched += 1;
      if (out.length < limit) out.push(e);
    }
    out.reverse();
    return {
      entries: out,
      matched,
      truncated: matched > out.length,
      buffered: count,
      bufferSize: size,
      oldestAt: count ? ring[start].at : null,
      droppedBeforeOldest: dropped,
      captureLevel: NAMES[captureLevel]
    };
  }

  function setLevel(level) {
    captureLevel = levelValue(level, captureLevel);
  }

  return { install, uninstall, query, setLevel, _handler: handler, LEVELS };
}

module.exports = { createLogBuffer, LEVELS };
