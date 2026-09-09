'use strict';

/*
 * Benchmark against a real Node-RED runtime.
 *
 *   node test/bench.js --mode none                      # baseline, no plugin
 *   node test/bench.js --mode plugin                    # lib/runtime.js
 *   node test/bench.js --mode plugin --plugin other.js  # any implementation with the same entry point
 *
 * Options: --hops 6 --messages 1000 --payload small|medium|big --interval 250 --budget 5
 * Prints one JSON line with sequential latency percentiles, burst throughput,
 * event-loop stalls and (for plugins that expose it) the plugin's own stats.
 */

const path = require('path');
const { performance, monitorEventLoopDelay } = require('perf_hooks');
const { buildChainFlow, startNodeRed, httpJson } = require('./lib/embedded-node-red.js');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[arg.slice(2)] = next;
        i += 1;
      } else {
        out[arg.slice(2)] = 'true';
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const MODE = args.mode || 'plugin';
const HOPS = Number(args.hops || 6);
const MESSAGES = Number(args.messages || 1000);
const PAYLOAD = args.payload || 'medium';
const PLUGIN_FILE = path.resolve(args.plugin || path.join(__dirname, '..', 'lib', 'runtime.js'));

const sharedImage = Buffer.alloc(4 * 1024 * 1024, 1);
function makeMsg() {
  const msg = { payload: { hop: 0 } };
  if (PAYLOAD === 'small') {
    msg.payload.text = 'hello';
    return msg;
  }
  msg.topic = 'camera/1';
  msg.payload.meta = {
    camera: 'cam1', width: 2048, height: 1536, exposure: 1200, gain: 2.5,
    timestamp: Date.now(), frame: 12345, format: 'BGR8', fps: 30, lot: 'L-2026-09-09',
    calibration: { fx: 1234.5, fy: 1234.5, cx: 1024, cy: 768, k: [0.1, -0.01, 0.001, 0, 0] },
    operator: 'line-3', station: 'inspection-A', recipe: 'default', version: '2.1.0', notes: 'x'.repeat(300),
  };
  msg.payload.detections = [];
  for (let i = 0; i < 50; i += 1) {
    msg.payload.detections.push({
      id: i, label: 'defect', score: 0.9 - i * 0.01, bbox: [10 + i, 20 + i, 30, 40],
      attributes: { area: 12 * i, severity: 'low', tags: ['a', 'b'] },
    });
  }
  if (PAYLOAD === 'big') {
    msg.payload.image = sharedImage;
  }
  return msg;
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  const settings = {};
  if (args.interval !== undefined || args.budget !== undefined) {
    settings.plugins = {
      '@rosepetal/node-red-contrib-message-control': {
        captureInterval: Number(args.interval === undefined ? 250 : args.interval),
        captureBudget: Number(args.budget === undefined ? 5 : args.budget),
      },
    };
  }
  const host = await startNodeRed({ flow: buildChainFlow(HOPS), settings });
  const { RED, port, bench } = host;
  let api = null;
  if (MODE !== 'none') {
    api = require(PLUGIN_FILE)(RED);
  }
  const first = RED.nodes.getNode('f1');

  for (let i = 0; i < 100; i += 1) {
    first.receive(makeMsg());
    await bench.waitFor(1);
  }

  const latencies = [];
  const h1 = monitorEventLoopDelay({ resolution: 1 });
  h1.enable();
  const seqStart = performance.now();
  for (let i = 0; i < MESSAGES; i += 1) {
    const msg = makeMsg();
    const t0 = performance.now();
    first.receive(msg);
    await bench.waitFor(1);
    latencies.push(performance.now() - t0);
  }
  const seqMs = performance.now() - seqStart;
  h1.disable();

  const msgs = [];
  for (let i = 0; i < MESSAGES; i += 1) {
    msgs.push(makeMsg());
  }
  const h2 = monitorEventLoopDelay({ resolution: 1 });
  h2.enable();
  const t1 = performance.now();
  const burst = bench.waitFor(MESSAGES, 120000);
  for (let i = 0; i < MESSAGES; i += 1) {
    first.receive(msgs[i]);
  }
  await burst;
  const burstMs = performance.now() - t1;
  h2.disable();

  latencies.sort((a, b) => a - b);
  const hopsPerMsg = HOPS + 1;
  const result = {
    mode: MODE,
    plugin: MODE === 'none' ? null : path.basename(PLUGIN_FILE),
    payload: PAYLOAD,
    hops: hopsPerMsg,
    messages: MESSAGES,
    node: process.version,
    nodeRed: host.nodeRedVersion,
    sequential: {
      p50_us: Math.round(percentile(latencies, 50) * 1000),
      p90_us: Math.round(percentile(latencies, 90) * 1000),
      p99_us: Math.round(percentile(latencies, 99) * 1000),
      max_us: Math.round(latencies[latencies.length - 1] * 1000),
      mean_us: Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 1000),
      total_ms: Math.round(seqMs),
      loopDelay_p99_ms: Math.round(h1.percentile(99) / 1e4) / 100,
      loopDelay_max_ms: Math.round(h1.max / 1e4) / 100,
    },
    burst: {
      total_ms: Math.round(burstMs * 100) / 100,
      msgs_per_s: Math.round(MESSAGES / (burstMs / 1000)),
      us_per_hop: Math.round(((burstMs * 1000) / (MESSAGES * hopsPerMsg)) * 100) / 100,
      loopDelay_max_ms: Math.round(h2.max / 1e4) / 100,
    },
  };
  if (api && typeof api.getStats === 'function') {
    result.pluginStats = api.getStats();
  }
  if (MODE !== 'none') {
    const snap = await httpJson('GET', `http://127.0.0.1:${port}/rosepetal/message-control/nodes/f3`);
    result.httpStatus = snap.status;
    result.snapshotMeta = snap.body && typeof snap.body === 'object' ? {
      lastInputAt: snap.body.lastInputAt,
      lastOutputAt: snap.body.lastOutputAt,
      inputCount: snap.body.inputCount,
      outputCount: snap.body.outputCount,
      inputSkipped: snap.body.inputSkipped,
      outputSkipped: snap.body.outputSkipped,
    } : null;
  }
  console.log(JSON.stringify(result));
  if (api && typeof api.stop === 'function') {
    api.stop();
  }
  await host.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
