'use strict';

/*
 * End-to-end: the runtime tools of the plugin loaded by Node-RED itself —
 * log buffer, module files, send to node (skipped when node-red is not
 * resolvable: set NODE_RED_PATH or `npm install node-red`).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { findNodeRed, buildChainFlow, startNodeRed, httpJson } = require('./lib/embedded-node-red.js');

const NODE_RED_PATH = findNodeRed();

test('runtime tools against a real Node-RED', { skip: !NODE_RED_PATH && 'node-red not installed' }, async (t) => {
  const flow = buildChainFlow(2);
  flow.push({
    id: 'broken', type: 'function', z: 'tab1', name: 'broken', func: 'return msg;;; not javascript', outputs: 1,
    timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [], x: 100, y: 300, wires: [[]]
  });
  const host = await startNodeRed({ nodeRedPath: NODE_RED_PATH, flow, installPlugin: true });
  const base = `http://127.0.0.1:${host.port}/rosepetal/message-control`;
  try {
    await t.test('the log buffer has the construction error of a node, with its id', async () => {
      const res = await httpJson('GET', `${base}/logs?level=error&node=broken`);
      assert.equal(res.status, 200);
      assert.equal(res.body.entries.length >= 1, true, JSON.stringify(res.body));
      assert.equal(res.body.entries[0].type, 'function');
      assert.match(res.body.entries[0].text, /SyntaxError/);
      const startup = await httpJson('GET', `${base}/logs?text=${encodeURIComponent('Started flows')}`);
      assert.ok(startup.body.entries.length >= 1, 'info lines from start-up are kept');
    });

    await t.test('module files of a private package are listed, searched and read', async () => {
      const pkg = path.join(host.userDir, 'node_modules', '@acme', 'private-nodes');
      fs.mkdirSync(path.join(pkg, 'nodes'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"@acme/private-nodes"}');
      fs.writeFileSync(path.join(pkg, 'nodes', 'vision.js'), 'const threshold = 0.82;\nmodule.exports = () => threshold;\n');
      const list = await httpJson('GET', `${base}/module-files?module=${encodeURIComponent('@acme/private-nodes')}`);
      assert.deepEqual(list.body.files.map(f => f.path).sort(), ['nodes/vision.js', 'package.json']);
      const found = await httpJson('GET', `${base}/module-files/search?module=${encodeURIComponent('@acme/private-nodes')}&query=threshold`);
      assert.equal(found.body.matches.length, 2);
      const read = await httpJson('GET', `${base}/module-files/read?module=${encodeURIComponent('@acme/private-nodes')}&path=nodes/vision.js&from=1&to=1`);
      assert.equal(read.body.text, 'const threshold = 0.82;');
      const escape = await httpJson('GET', `${base}/module-files/read?module=${encodeURIComponent('@acme/private-nodes')}&path=../../../settings.js`);
      assert.equal(escape.status, 400);
      const core = await httpJson('GET', `${base}/module-files/search?module=node-red&query=registerType(%22debug%22&glob=**/*.js`);
      assert.equal(core.status, 200, JSON.stringify(core.body));
    });
  } finally {
    await host.stop();
  }
});
