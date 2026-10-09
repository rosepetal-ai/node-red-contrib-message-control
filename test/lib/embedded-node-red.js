'use strict';

/*
 * Boots a real Node-RED runtime in-process for end-to-end tests and benchmarks.
 * Node-RED is resolved from (in order): NODE_RED_PATH, the local node_modules,
 * the global npm root. Returns null from findNodeRed() when unavailable.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execSync } = require('child_process');

function findNodeRed() {
  const candidates = [];
  if (process.env.NODE_RED_PATH) {
    candidates.push(process.env.NODE_RED_PATH);
  }
  try {
    candidates.push(path.dirname(require.resolve('node-red/package.json', { paths: [process.cwd(), __dirname] })));
  } catch (err) {
    // not installed locally
  }
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    candidates.push(path.join(globalRoot, 'node-red'));
  } catch (err) {
    // npm not available
  }
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }
  return null;
}

function functionNode(id, name, func, wires, x) {
  return {
    id,
    type: 'function',
    z: 'tab1',
    name,
    func,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x,
    y: 100,
    wires: [wires],
  };
}

/**
 * Build a linear flow: f1 -> f2 -> ... -> fN -> sink.
 * `funcs[i]` is the body of function node i (defaults to a hop counter);
 * the sink calls global.get('bench').done(msg).
 */
function buildChainFlow(hops, funcs = []) {
  const nodes = [{ id: 'tab1', type: 'tab', label: 'test', disabled: false, info: '' }];
  for (let i = 1; i <= hops; i += 1) {
    const body = funcs[i - 1] || 'msg.payload.hop = (msg.payload.hop || 0) + 1; return msg;';
    nodes.push(functionNode(`f${i}`, `hop ${i}`, body, [i === hops ? 'sink' : `f${i + 1}`], 100 * i));
  }
  nodes.push(functionNode('sink', 'sink', 'global.get("bench").done(msg); return null;', [], 100 * (hops + 1)));
  return nodes;
}

/**
 * Start Node-RED with the given flow. Resolves with { RED, port, bench, stop }.
 * `bench.done` is invoked by the sink node; `bench.waitFor(n)` resolves once
 * n more messages reached the sink.
 */
async function startNodeRed({ nodeRedPath, flow, settings = {}, installPlugin = false }) {
  const NR = nodeRedPath || findNodeRed();
  if (!NR) {
    throw new Error('node-red not found (set NODE_RED_PATH or npm install node-red)');
  }
  const RED = require(NR);
  const express = require(require.resolve('express', { paths: [NR] }));

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rosepetal-mc-'));
  fs.writeFileSync(path.join(userDir, 'flows.json'), JSON.stringify(flow));
  if (installPlugin) {
    // Let Node-RED load this package from userDir/node_modules at start-up,
    // exactly like an npm install would.
    const scope = path.join(userDir, 'node_modules', '@rosepetal');
    fs.mkdirSync(scope, { recursive: true });
    fs.symlinkSync(path.resolve(__dirname, '..', '..'), path.join(scope, 'node-red-contrib-message-control'), 'dir');
  }

  let pendingResolve = null;
  let pendingTarget = 0;
  let delivered = 0;
  const bench = {
    delivered: 0,
    done() {
      delivered += 1;
      bench.delivered = delivered;
      if (pendingResolve && delivered >= pendingTarget) {
        const r = pendingResolve;
        pendingResolve = null;
        r();
      }
    },
    waitFor(count, timeoutMs = 10000) {
      pendingTarget = delivered + count;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingResolve = null;
          reject(new Error(`timeout waiting for ${count} message(s); delivered=${delivered}`));
        }, timeoutMs);
        pendingResolve = () => {
          clearTimeout(timer);
          resolve();
        };
        if (delivered >= pendingTarget) {
          pendingResolve();
        }
      });
    },
  };

  const app = express();
  const server = http.createServer(app);
  const fullSettings = {
    userDir,
    flowFile: 'flows.json',
    httpAdminRoot: '/',
    httpNodeRoot: '/',
    disableEditor: true,
    functionGlobalContext: { bench },
    logging: { console: { level: 'error', metrics: false, audit: false } },
    editorTheme: {},
    credentialSecret: false,
    ...settings,
  };
  RED.init(server, fullSettings);
  app.use('/', RED.httpAdmin);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await RED.start();
  const deadline = Date.now() + 20000;
  while (!RED.nodes.getNode('sink')) {
    if (Date.now() > deadline) {
      throw new Error('flows did not start');
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  async function stop() {
    try {
      await RED.stop();
    } finally {
      server.close();
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  }

  return { RED, port, bench, stop, nodeRedVersion: require(path.join(NR, 'package.json')).version };
}

function httpJson(method, url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {};
    const req = http.request(url, {
      method,
      headers: { ...headers, ...extraHeaders },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let parsed = text;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          // leave as text
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

module.exports = { findNodeRed, buildChainFlow, startNodeRed, httpJson };
