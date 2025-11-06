'use strict';

const MAX_SERIALIZED_LENGTH = 262144; // 256 KB safety net for stored snapshots
const HOOK_NAMESPACE = 'rosepetal-message-control';

let instrumentationApplied = false;
const lastMessages = new Map();

function noopMiddleware(req, res, next) {
  next();
}

function makePermissionMiddleware(RED) {
  if (RED.auth && typeof RED.auth.needsPermission === 'function') {
    return RED.auth.needsPermission('flows.read');
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
  const store = ensureEntry(node);
  if (!store) {
    return;
  }
  store.lastInput = summarizeMessage(cloneForStorage(RED, msg));
  store.lastInputAt = Date.now();
}

function recordOutput(RED, node, msg) {
  const store = ensureEntry(node);
  if (!store) {
    return;
  }
  store.lastOutput = summarizeMessage(cloneForStorage(RED, msg));
  store.lastOutputAt = Date.now();
}

function registerHttpEndpoints(RED) {
  const permission = makePermissionMiddleware(RED);
  const basePath = '/rosepetal/message-control';

  RED.httpAdmin.get(`${basePath}/nodes`, permission, function (req, res) {
    const response = Array.from(lastMessages.values()).map((entry) => ({
      id: entry.id,
      type: entry.type,
      name: entry.name,
      lastInputAt: entry.lastInputAt,
      lastOutputAt: entry.lastOutputAt,
    }));
    res.json(response);
  });

  RED.httpAdmin.get(`${basePath}/nodes/:id`, permission, function (req, res) {
    const entry = lastMessages.get(req.params.id);
    if (!entry) {
      res.status(404).json({ error: 'unknown_node', message: `No messages recorded for node ${req.params.id}` });
      return;
    }
    res.json(entry);
  });
}

module.exports = function register(RED) {
  if (instrumentationApplied) {
    return;
  }
  instrumentationApplied = true;

  if (!RED || !RED.nodes || typeof RED.nodes.eachNode !== 'function') {
    throw new Error('rosepetal-message-control: Unexpected RED runtime shape - unable to access runtime nodes');
  }

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

  RED.log && RED.log.info('rosepetal-message-control: message snapshots enabled for all nodes');

  return {
    getLastMessages() {
      return Array.from(lastMessages.values());
    },
    getLastMessageForNode(id) {
      return lastMessages.get(id) || null;
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
