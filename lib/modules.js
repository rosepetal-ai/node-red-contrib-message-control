'use strict';

/*
 * Read-only access to the code of installed node modules: list, search and
 * read files of a package in userDir/node_modules (or Node-RED's core
 * nodes). Built for private packages, whose code is nowhere else.
 *
 * Confinement: the package directory is resolved through realpath, and
 * every file is realpath-checked to stay inside it (a symlink inside the
 * package cannot lead out); dot directories and nested node_modules are
 * skipped unless asked; binary files are not read.
 * Non-blocking: only fs.promises / opendir (every file read yields to the
 * event loop), with hard limits on files visited, bytes read per file and
 * in total, matches, and a time budget. Searches are plain substrings —
 * never caller-supplied regular expressions, which could hang the runtime.
 */

const fs = require('fs');
const path = require('path');

const NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const LIMITS = {
  maxFiles: 5000,            // files visited by a listing or search
  maxSearchFileBytes: 2 * 1024 * 1024,
  maxSearchTotalBytes: 64 * 1024 * 1024,
  maxReadBytes: 4 * 1024 * 1024,
  maxReturnChars: 200 * 1024,
  timeBudgetMs: 5000,
  maxMatches: 500
};
const TEXT_EXT = /\.(js|mjs|cjs|ts|json|html?|css|md|txt|ya?ml|xml|svg|vue|jsx|tsx|sh|py|ini|cfg|conf|properties|map|lock|d\.ts|njk|ejs|hbs)$/i;

class ModuleFilesError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function within(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function createModuleFiles(RED, options = {}) {
  const limits = { ...LIMITS, ...(options.limits || {}) };

  function roots() {
    const out = [];
    const userDir = RED.settings && (RED.settings.userDir || (typeof RED.settings.get === 'function' && safeGet('userDir')));
    if (userDir) out.push({ kind: 'user', dir: path.join(userDir, 'node_modules') });
    const core = RED.settings && (RED.settings.coreNodesDir || safeGet('coreNodesDir'));
    if (core) out.push({ kind: 'core', dir: core });
    return out;
  }

  function safeGet(key) {
    try {
      return RED.settings.get(key);
    } catch (err) {
      return undefined;
    }
  }

  async function packageDir(module) {
    if (typeof module !== 'string' || !NAME_RE.test(module)) {
      throw new ModuleFilesError(400, 'invalid_module', 'module must be an npm package name (e.g. "node-red-contrib-x" or "@scope/pkg"), or "node-red" for the core nodes');
    }
    const candidates = module === 'node-red' || module === '@node-red/nodes'
      ? roots().filter(r => r.kind === 'core').map(r => r.dir)
      : roots().filter(r => r.kind === 'user').map(r => path.join(r.dir, module));
    for (const candidate of candidates) {
      try {
        const real = await fs.promises.realpath(candidate);
        const stat = await fs.promises.stat(real);
        if (stat.isDirectory()) return real;
      } catch (err) {
        // try the next root
      }
    }
    throw new ModuleFilesError(404, 'unknown_module', `module ${module} is not installed in the Node-RED user directory`);
  }

  async function safeFile(pkg, rel) {
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new ModuleFilesError(400, 'invalid_path', 'path is required');
    const joined = path.resolve(pkg, rel);
    if (!within(pkg, joined)) throw new ModuleFilesError(400, 'invalid_path', 'path leaves the module directory');
    let real;
    try {
      real = await fs.promises.realpath(joined);
    } catch (err) {
      throw new ModuleFilesError(404, 'not_found', `${rel} does not exist in the module`);
    }
    if (!within(pkg, real)) throw new ModuleFilesError(403, 'outside_module', `${rel} resolves outside the module directory`);
    const stat = await fs.promises.stat(real);
    if (!stat.isFile()) throw new ModuleFilesError(400, 'not_a_file', `${rel} is not a file`);
    return { real, stat };
  }

  function looksBinary(buffer) {
    const n = Math.min(buffer.length, 8000);
    for (let i = 0; i < n; i += 1) if (buffer[i] === 0) return true;
    return false;
  }

  function globToRegExp(glob) {
    // Only * (no slash), ** (anything) and ? — no user regex reaches RegExp.
    if (typeof glob !== 'string' || glob.length > 200) throw new ModuleFilesError(400, 'invalid_glob', 'glob must be a string of at most 200 characters');
    glob = glob.replace(/(\*\*\/?)+/g, '**/').replace(/\*\*\/$/, '**');
    let out = '';
    for (let i = 0; i < glob.length; i += 1) {
      const c = glob[i];
      if (c === '*') {
        if (glob[i + 1] === '*') { out += '.*'; i += 1; if (glob[i + 1] === '/') i += 1; } else out += '[^/]*';
      } else if (c === '?') out += '[^/]';
      else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out}$`);
  }

  /** Walks the package, yielding relative file paths (bounded). */
  async function* walk(pkg, { includeDependencies = false } = {}, state) {
    const stack = [''];
    while (stack.length) {
      const relDir = stack.pop();
      let dir;
      try {
        dir = await fs.promises.opendir(path.join(pkg, relDir));
      } catch (err) {
        continue;
      }
      const subdirs = [];
      for await (const entry of dir) {
        if (Date.now() > state.deadline) { state.timedOut = true; return; }
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.')) continue;
          if (entry.name === 'node_modules' && !includeDependencies) { state.skippedDependencies = true; continue; }
          subdirs.push(rel);
        } else if (entry.isFile()) {
          state.files += 1;
          if (state.files > limits.maxFiles) { state.fileLimit = true; return; }
          yield rel;
        }
      }
      stack.push(...subdirs.sort().reverse());
    }
  }

  async function list(module, { glob, includeDependencies = false } = {}) {
    const pkg = await packageDir(module);
    const state = { files: 0, deadline: Date.now() + limits.timeBudgetMs };
    const filter = glob ? globToRegExp(glob) : null;
    const files = [];
    for await (const rel of walk(pkg, { includeDependencies }, state)) {
      if (filter && !filter.test(rel)) continue;
      const stat = await fs.promises.stat(path.join(pkg, rel)).catch(() => null);
      files.push({ path: rel, size: stat ? stat.size : null });
      if (files.length >= limits.maxMatches * 4) { state.listLimit = true; break; }
    }
    return { module, files, ...limitNotes(state) };
  }

  function limitNotes(state) {
    const notes = [];
    if (state.timedOut) notes.push(`stopped after ${limits.timeBudgetMs} ms`);
    if (state.fileLimit) notes.push(`stopped after ${limits.maxFiles} files`);
    if (state.byteLimit) notes.push(`stopped after reading ${limits.maxSearchTotalBytes} bytes`);
    if (state.listLimit) notes.push('listing capped');
    return { complete: notes.length === 0, notes, skippedDependencies: Boolean(state.skippedDependencies) };
  }

  async function search(module, { query, caseSensitive = false, glob, includeDependencies = false, limit = 100 } = {}) {
    if (typeof query !== 'string' || !query) throw new ModuleFilesError(400, 'invalid_query', 'query (plain text) is required');
    const pkg = await packageDir(module);
    const needle = caseSensitive ? query : query.toLowerCase();
    const max = Math.max(1, Math.min(limits.maxMatches, Math.floor(Number(limit) || 100)));
    const filter = glob ? globToRegExp(glob) : null;
    const state = { files: 0, bytes: 0, deadline: Date.now() + limits.timeBudgetMs };
    const matches = [];
    let filesWithMatches = 0;
    let searched = 0;
    let binary = 0;
    outer:
    for await (const rel of walk(pkg, { includeDependencies }, state)) {
      if (filter && !filter.test(rel)) continue;
      let stat;
      try {
        stat = await fs.promises.stat(path.join(pkg, rel));
      } catch (err) {
        continue;
      }
      if (stat.size > limits.maxSearchFileBytes) continue;
      if (state.bytes + stat.size > limits.maxSearchTotalBytes) { state.byteLimit = true; break; }
      let buffer;
      try {
        const { real } = await safeFile(pkg, rel);
        buffer = await fs.promises.readFile(real);
      } catch (err) {
        continue;
      }
      state.bytes += buffer.length;
      if (!TEXT_EXT.test(rel) && looksBinary(buffer)) { binary += 1; continue; }
      searched += 1;
      const lines = buffer.toString('utf8').split('\n');
      let found = false;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if ((caseSensitive ? line : line.toLowerCase()).includes(needle)) {
          if (!found) { filesWithMatches += 1; found = true; }
          matches.push({ path: rel, line: i + 1, text: line.length > 300 ? `${line.slice(0, 300)}…` : line });
          if (matches.length >= max) { state.matchLimit = true; break outer; }
        }
      }
      if (Date.now() > state.deadline) { state.timedOut = true; break; }
    }
    return { module, query, matches, filesSearched: searched, filesWithMatches, binarySkipped: binary, truncated: Boolean(state.matchLimit), ...limitNotes(state) };
  }

  async function read(module, relPath, { from, to } = {}) {
    const pkg = await packageDir(module);
    const { real, stat } = await safeFile(pkg, relPath);
    if (stat.size > limits.maxReadBytes) {
      throw new ModuleFilesError(413, 'too_large', `${relPath} is ${stat.size} bytes; files up to ${limits.maxReadBytes} bytes can be read`);
    }
    const buffer = await fs.promises.readFile(real);
    if (!TEXT_EXT.test(relPath) && looksBinary(buffer)) throw new ModuleFilesError(415, 'binary', `${relPath} is a binary file`);
    const lines = buffer.toString('utf8').split('\n');
    const first = Math.max(1, Math.floor(Number(from) || 1));
    let last = Math.min(lines.length, Math.floor(Number(to) || lines.length));
    let text = lines.slice(first - 1, last).join('\n');
    let truncated = false;
    if (text.length > limits.maxReturnChars) {
      // keep whole lines within the budget
      let chars = 0;
      let i = first - 1;
      for (; i < last; i += 1) {
        chars += lines[i].length + 1;
        if (chars > limits.maxReturnChars) break;
      }
      last = Math.max(first, i);
      text = lines.slice(first - 1, last).join('\n');
      truncated = true;
    }
    return { module, path: relPath, size: stat.size, totalLines: lines.length, from: first, to: last, truncated, text };
  }

  return { list, search, read, packageDir, limits };
}

module.exports = { createModuleFiles, ModuleFilesError };
