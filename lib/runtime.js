'use strict';

const MAX_SERIALIZED_LENGTH = 262144; // 256 KB safety net for stored snapshots
const HOOK_NAMESPACE = 'rosepetal-message-control';
const PLUGIN_ID = 'node-red-contrib-rosepetal-message-control';

const CLEAN_SANITIZE_DEFAULTS = {
  maxDepth: 6,
  maxArrayLength: 50,
  maxObjectKeys: 60,
  maxStringLength: 2048,
  bufferPreviewLength: 0,
};

const DEFAULT_SETTINGS = {
  enabled: true,
};

const CLEAN_TRUNCATED_FLAG = '__rosepetalCleanTruncated';
const CLEAN_NOTE_KEY = '__rosepetalCleanNote';
const MAX_SETTINGS_BODY_SIZE = 1024 * 1024; // 1 MB limit for settings payloads

let instrumentationApplied = false;
const lastMessages = new Map();
const runtimeSettings = { ...DEFAULT_SETTINGS };

function noopMiddleware(req, res, next) {
  next();
}

function makePermissionMiddleware(RED, permission = 'flows.read') {
  if (RED.auth && typeof RED.auth.needsPermission === 'function') {
    return RED.auth.needsPermission(permission);
  }
  return noopMiddleware;
}

function cloneForStorage(RED, payload) {
  if (payload === null || payload === undefined) {
    return payload;
  }

  if (Array.isArray(payload)) {
    return payload.map((item) => cloneForStorage(RED, item));
  }

  if (typeof payload === 'object') {
    try {
      if (RED.util && typeof RED.util.cloneMessage === 'function') {
        return RED.util.cloneMessage(payload);
      }
      return JSON.parse(JSON.stringify(payload));
    } catch (err) {
      return {
        $$error: 'Unable to clone message payload',
        message: err.message,
      };
    }
  }

  return payload;
}

function summarizeMessage(payload) {
  try {
    const serialized = JSON.stringify(payload);
    if (serialized && serialized.length > MAX_SERIALIZED_LENGTH) {
      return {
        $$truncated: true,
        preview: serialized.slice(0, MAX_SERIALIZED_LENGTH),
        originalLength: serialized.length,
      };
    }
  } catch (err) {
    return {
      $$error: 'Unable to stringify payload',
      message: err.message,
      type: typeof payload,
    };
  }
  return payload;
}

function sanitizeForStorage(value, overrides = {}) {
  const opts = {
    ...CLEAN_SANITIZE_DEFAULTS,
    ...overrides,
  };
  const seen = new WeakMap();

  function helper(current, depth, path) {
    if (current === null || current === undefined) {
      return current;
    }

    const valueType = typeof current;
    if (valueType === 'number' || valueType === 'boolean') {
      return current;
    }
    if (valueType === 'bigint') {
      return `${current.toString()}n`;
    }
    if (valueType === 'string') {
      return sanitizeString(current, opts);
    }
    if (valueType === 'symbol') {
      return current.toString();
    }
    if (valueType === 'function') {
      return `[Function ${current.name || 'anonymous'}]`;
    }

    if (Buffer.isBuffer(current)) {
      return createPlaceholder('Buffer', `${current.length} bytes`);
    }
    if (ArrayBuffer.isView(current) && !(current instanceof DataView)) {
      return encodeTypedArray(current, opts);
    }
    if (current instanceof ArrayBuffer) {
      return encodeTypedArray(new Uint8Array(current), opts);
    }
    if (current instanceof Date) {
      return current.toISOString();
    }
    if (current instanceof RegExp) {
      return current.toString();
    }

    if (typeof current === 'object') {
      if (seen.has(current)) {
        return `[Circular ~${seen.get(current)}]`;
      }
      seen.set(current, path || '~');

      if (current.type === 'Buffer' && Array.isArray(current.data)) {
        return createPlaceholder('Buffer', `${current.data.length} bytes`);
      }

      if (depth >= opts.maxDepth) {
        if (Array.isArray(current)) {
          return `[Array(${current.length})]`;
        }
        return `[Object with ${Object.keys(current).length} keys]`;
      }

      if (Array.isArray(current)) {
        const len = Math.min(current.length, opts.maxArrayLength);
        const subset = [];
        for (let i = 0; i < len; i += 1) {
          subset.push(helper(current[i], depth + 1, `${path || '~'}[${i}]`));
        }
        if (current.length > opts.maxArrayLength) {
          subset.push(`… ${current.length - opts.maxArrayLength} more items`);
        }
        return subset;
      }

      const keys = Object.keys(current);
      const clone = {};
      const limit = Math.min(keys.length, opts.maxObjectKeys);
      for (let i = 0; i < limit; i += 1) {
        const key = keys[i];
        clone[key] = helper(current[key], depth + 1, path ? `${path}.${key}` : key);
      }
      if (keys.length > opts.maxObjectKeys) {
        clone[CLEAN_TRUNCATED_FLAG] = true;
        clone[CLEAN_NOTE_KEY] = `${keys.length - opts.maxObjectKeys} more keys not shown`;
      }
      return clone;
    }

    return current;
  }

  return helper(value, 0, '');
}

function sanitizeString(value, opts) {
  const trimmed = value.trim();
  if (trimmed.startsWith('data:image/')) {
    return createPlaceholder('DataImage', `${value.length} chars`);
  }
  if (isLikelyBase64(trimmed)) {
    return createPlaceholder('Base64', `${value.length} chars`);
  }
  if (value.length > opts.maxStringLength) {
    return `${value.slice(0, opts.maxStringLength)}… [truncated ${value.length - opts.maxStringLength} chars]`;
  }
  return value;
}

function encodeTypedArray(view, opts) {
  const ctor = view.constructor && view.constructor.name ? view.constructor.name : 'TypedArray';
  if (opts.bufferPreviewLength <= 0) {
    return createPlaceholder(ctor, `${view.length} items`);
  }
  const limit = Math.min(view.length, opts.maxArrayLength);
  const data = [];
  for (let i = 0; i < limit; i += 1) {
    data.push(view[i]);
  }
  const descriptor = {
    type: ctor,
    length: view.length,
    data,
  };
  if (limit < view.length) {
    descriptor[CLEAN_TRUNCATED_FLAG] = true;
    descriptor[CLEAN_NOTE_KEY] = `${view.length - limit} more items not shown`;
  }
  return descriptor;
}

function isLikelyBase64(value) {
  if (value.length < 512) {
    return false;
  }
  if (value.length % 4 !== 0) {
    return false;
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(value)) {
    return false;
  }
  const paddingRatio = (value.match(/=/g) || []).length / value.length;
  return paddingRatio < 0.1;
}

function createPlaceholder(type, detail) {
  return `[${type} withheld: ${detail}]`;
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
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
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
      if (finished) {
        return;
      }
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

function getPluginConfigurationFromSettings(RED) {
  if (!RED || !RED.settings || !RED.settings.plugins) {
    return {};
  }
  return RED.settings.plugins[PLUGIN_ID] || {};
}

function applySettings(update = {}, options = {}) {
  const next = { ...runtimeSettings };
  let mutated = false;

  if (Object.prototype.hasOwnProperty.call(update, 'enabled') && typeof update.enabled === 'boolean') {
    next.enabled = update.enabled;
    mutated = true;
  }

  if (!mutated) {
    return { ...runtimeSettings };
  }

  const previousEnabled = runtimeSettings.enabled;
  runtimeSettings.enabled = next.enabled;

  if (previousEnabled && !runtimeSettings.enabled) {
    lastMessages.clear();
  }
  if (!options.skipMetadataRefresh && runtimeSettings.enabled && !previousEnabled) {
    // Metadata will be repopulated on next record cycle, but ensure entries exist for active nodes if RED is available.
    options.RED && refreshNodeMetadata(options.RED);
  }

  return { ...runtimeSettings };
}

function getCurrentSettings() {
  return { ...runtimeSettings };
}

function initializeSettings(RED) {
  const configured = getPluginConfigurationFromSettings(RED);
  const initial = {};
  if (Object.prototype.hasOwnProperty.call(configured, 'captureEnabled') && typeof configured.captureEnabled === 'boolean') {
    initial.enabled = configured.captureEnabled;
  }
  if (Object.keys(initial).length) {
    applySettings(initial, { skipMetadataRefresh: true });
  }
}

function prepareSnapshotPayload(RED, payload) {
  const cloned = cloneForStorage(RED, payload);
  try {
    const sanitized = sanitizeForStorage(cloned);
    return summarizeMessage(sanitized);
  } catch (err) {
    return {
      $$error: 'Unable to sanitise payload',
      message: err.message,
    };
  }
}

function ensureEntry(source) {
  if (!source || !source.id) {
    return null;
  }
  if (!lastMessages.has(source.id)) {
    lastMessages.set(source.id, {
      id: source.id,
      type: source.type || '',
      name: source.name || '',
      lastInput: null,
      lastInputAt: null,
      lastOutput: null,
      lastOutputAt: null,
    });
  }
  const entry = lastMessages.get(source.id);
  if (source.type) {
    entry.type = source.type;
  }
  if (typeof source.name === 'string') {
    entry.name = source.name;
  }
  return entry;
}

function refreshNodeMetadata(RED) {
  if (!RED.nodes || typeof RED.nodes.eachNode !== 'function') {
    return;
  }
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
      ensureEntry(n);
    });
  } catch (err) {
    // Runtime may not have loaded flows yet; retry on next flows:started event
    return;
  }
  for (const id of Array.from(lastMessages.keys())) {
    if (!activeIds.has(id)) {
      lastMessages.delete(id);
    }
  }
}

function recordInput(RED, node, msg) {
  if (!runtimeSettings.enabled) {
    return;
  }
  const store = ensureEntry(node);
  if (!store) {
    return;
  }
  store.lastInput = prepareSnapshotPayload(RED, msg);
  store.lastInputAt = Date.now();
}

function recordOutput(RED, node, msg) {
  if (!runtimeSettings.enabled) {
    return;
  }
  const store = ensureEntry(node);
  if (!store) {
    return;
  }
  store.lastOutput = prepareSnapshotPayload(RED, msg);
  store.lastOutputAt = Date.now();
}

function registerHttpEndpoints(RED) {
  const readPermission = makePermissionMiddleware(RED, 'flows.read');
  const writePermission = makePermissionMiddleware(RED, 'flows.write');
  const jsonParser = RED.bodyParser && typeof RED.bodyParser.json === 'function' ? RED.bodyParser.json({ limit: '1mb' }) : null;
  const basePath = '/rosepetal/message-control';

  RED.httpAdmin.get(`${basePath}/nodes`, readPermission, function (req, res) {
    const response = Array.from(lastMessages.values()).map((entry) => ({
      id: entry.id,
      type: entry.type,
      name: entry.name,
      lastInputAt: entry.lastInputAt,
      lastOutputAt: entry.lastOutputAt,
    }));
    res.json(response);
  });

  RED.httpAdmin.get(`${basePath}/nodes/:id`, readPermission, function (req, res) {
    const entry = lastMessages.get(req.params.id);
    if (!entry) {
      res.status(404).json({ error: 'unknown_node', message: `No messages recorded for node ${req.params.id}` });
      return;
    }
    res.json(entry);
  });

  RED.httpAdmin.get(`${basePath}/settings`, readPermission, function (req, res) {
    res.json(getCurrentSettings());
  });

  const settingsHandler = function (req, res) {
    ensureJsonBody(req)
      .then((body) => {
        const source = body || {};
        const update = {};
        if (Object.prototype.hasOwnProperty.call(source, 'enabled')) {
          update.enabled = !!source.enabled;
        }
        if (!Object.keys(update).length) {
          res.status(400).json({ error: 'invalid_request', message: 'No valid setting provided' });
          return;
        }
        const applied = applySettings(update, { RED });
        res.json(applied);
      })
      .catch((err) => {
        const status = err && err.status ? err.status : 400;
        res.status(status).json({
          error: (err && err.code) || 'invalid_request',
          message: err && err.message ? err.message : 'Unable to parse request body',
        });
      });
  };

  if (jsonParser) {
    RED.httpAdmin.post(`${basePath}/settings`, writePermission, jsonParser, settingsHandler);
  } else {
    RED.httpAdmin.post(`${basePath}/settings`, writePermission, settingsHandler);
  }
}

module.exports = function register(RED) {
  if (instrumentationApplied) {
    return;
  }
  instrumentationApplied = true;

  if (!RED || !RED.nodes || typeof RED.nodes.eachNode !== 'function') {
    throw new Error('rosepetal-message-control: Unexpected RED runtime shape - unable to access runtime nodes');
  }

  initializeSettings(RED);
  registerHttpEndpoints(RED);

  if (!RED.hooks || typeof RED.hooks.add !== 'function') {
    throw new Error('rosepetal-message-control: RED.hooks API not available');
  }

  const safeHandler = (fn) => (payload, done) => {
    try {
      fn(payload);
      done();
    } catch (err) {
      done(err);
    }
  };

  RED.hooks.add(`onReceive.${HOOK_NAMESPACE}`, safeHandler((event) => {
    if (!event || !event.destination || !event.destination.node) {
      return;
    }
    recordInput(RED, event.destination.node, event.msg);
  }));

  RED.hooks.add(`onSend.${HOOK_NAMESPACE}`, safeHandler((events) => {
    if (!Array.isArray(events)) {
      return;
    }
    for (const ev of events) {
      if (!ev || !ev.source || !ev.source.node) {
        continue;
      }
      recordOutput(RED, ev.source.node, ev.msg);
    }
  }));

  refreshNodeMetadata(RED);

  if (RED.events && typeof RED.events.on === 'function') {
    RED.events.on('flows:started', function handleFlowsStarted() {
      refreshNodeMetadata(RED);
    });
  }

  if (RED.log && typeof RED.log.info === 'function') {
    RED.log.info(`rosepetal-message-control: snapshot instrumentation loaded (enabled=${runtimeSettings.enabled})`);
  }

  return {
    getLastMessages() {
      return Array.from(lastMessages.values());
    },
    getLastMessageForNode(id) {
      return lastMessages.get(id) || null;
    },
    getSettings: getCurrentSettings,
    updateSettings(patch) {
      return applySettings(patch, { RED });
    },
    clear(id) {
      if (id) {
        lastMessages.delete(id);
      } else {
        lastMessages.clear();
      }
    },
    stop() {
      if (RED.hooks && typeof RED.hooks.remove === 'function') {
        try {
          RED.hooks.remove(`onReceive.${HOOK_NAMESPACE}`);
        } catch (err) {
          // ignore removal errors
        }
        try {
          RED.hooks.remove(`onSend.${HOOK_NAMESPACE}`);
        } catch (err) {
          // ignore removal errors
        }
      }
      lastMessages.clear();
      instrumentationApplied = false;
    },
  };
};
