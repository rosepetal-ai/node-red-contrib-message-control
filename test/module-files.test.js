'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createModuleFiles } = require('../lib/modules.js');

function moduleFixture() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mod-'));
  const pkg = path.join(userDir, 'node_modules', '@acme', 'node-red-private');
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"@acme/node-red-private"}');
  fs.writeFileSync(path.join(pkg, 'lib', 'camera.js'), 'module.exports = function (RED) {\n  // connect to the camera\n  const timeout = 5000;\n  RED.nodes.registerType("cam", Cam);\n};\n');
  fs.writeFileSync(path.join(pkg, 'lib', 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 0]));
  fs.writeFileSync(path.join(pkg, 'node_modules', 'dep', 'index.js'), 'const timeout = 1;\n');
  fs.writeFileSync(path.join(userDir, 'secret.txt'), 'top secret');
  fs.symlinkSync(path.join(userDir, 'secret.txt'), path.join(pkg, 'lib', 'escape.txt'));
  const mf = createModuleFiles({ settings: { userDir } });
  return { userDir, mf, cleanup: () => fs.rmSync(userDir, { recursive: true, force: true }) };
}

test('module files: list, search and read inside the package only', async () => {
  const { mf, cleanup } = moduleFixture();
  try {
    const listing = await mf.list('@acme/node-red-private');
    assert.deepEqual(listing.files.map(f => f.path).sort(), ['lib/blob.bin', 'lib/camera.js', 'package.json'], 'symlinks are not followed');
    assert.equal(listing.skippedDependencies, true);
    assert.deepEqual((await mf.list('@acme/node-red-private', { glob: '**/*.js' })).files.map(f => f.path), ['lib/camera.js']);

    const found = await mf.search('@acme/node-red-private', { query: 'TIMEOUT' });
    assert.deepEqual(found.matches, [{ path: 'lib/camera.js', line: 3, text: '  const timeout = 5000;' }]);
    assert.equal(found.binarySkipped, 1);
    const deps = await mf.search('@acme/node-red-private', { query: 'timeout', includeDependencies: true });
    assert.equal(deps.matches.length, 2);
    assert.equal((await mf.search('@acme/node-red-private', { query: 'TIMEOUT', caseSensitive: true })).matches.length, 0);

    const read = await mf.read('@acme/node-red-private', 'lib/camera.js', { from: 2, to: 3 });
    assert.equal(read.text, '  // connect to the camera\n  const timeout = 5000;');
    assert.equal(read.totalLines, 6);

    await assert.rejects(mf.read('@acme/node-red-private', 'lib/escape.txt'), /resolves outside the module directory/);
    await assert.rejects(mf.read('@acme/node-red-private', '../../secret.txt'), /leaves the module directory/);
    await assert.rejects(mf.read('@acme/node-red-private', 'lib/blob.bin'), /binary/);
    await assert.rejects(mf.list('not-installed'), /not installed/);
    await assert.rejects(mf.list('../etc'), /npm package name/);
    await assert.rejects(mf.search('@acme/node-red-private', { query: '' }), /query/);
  } finally {
    cleanup();
  }
});
