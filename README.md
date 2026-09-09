# @rosepetal/node-red-contrib-message-control

A Node-RED runtime plugin that remembers the last message each node received and sent. It gives you a live “what just happened?” snapshot without wiring extra debug nodes, and it is built so that it can stay enabled on a production runtime.

![Example](assets/example.png)

## Why you might want it
- **See data instantly**: select any runtime node in the editor and the latest inbound/outbound payloads appear in the Info sidebar.
- **Safe on the message path**: the hooks are synchronous, allocation-free and cost about 0.1 µs per message; snapshots are bounded, rate limited per node and capped by a global CPU budget. The plugin can never halt, delay or error a message.
- **Stay lightweight**: snapshots are cleaned (buffers, typed arrays, streams, long strings and base64 blobs become annotated placeholders) so they are safe to ship to the editor.
- **Pause when needed**: a single toggle removes the hooks from the router entirely; a paused plugin costs exactly nothing.
- **Script-friendly**: the same data, plus runtime statistics, is available over HTTP for tooling, tests, or dashboards.

## Quick start
1. Change into your Node-RED user directory (usually `~/.node-red`).
2. Install the plugin:
   ```bash
   npm install @rosepetal/node-red-contrib-message-control
   ```
3. Optionally tune it inside `settings.js` (every key is optional):
   ```js
   plugins: {
     '@rosepetal/node-red-contrib-message-control': {
       captureEnabled: true,   // start capturing on boot (default true)
       captureInterval: 250,   // ms between two snapshots of the same node & direction; 0 = every message
       captureBudget: 5,       // ms of snapshot CPU allowed per second across all nodes; 0 = unlimited
       snapshotLimits: {       // hard caps applied to every snapshot
         maxDepth: 6, maxArrayLength: 50, maxObjectKeys: 60,
         maxStringLength: 2048, maxValues: 2000, maxChars: 262144
       }
     }
   }
   ```
4. Restart Node-RED.

Node-RED 3.0+ is required because the plugin relies on the `RED.hooks` runtime API.

## Using the snapshots in the editor
1. Open the *Info* sidebar.
2. Click any node on the canvas.
3. A **Message Snapshot** card appears with two sections:
   - *Last Input*: the most recent sampled message the node received.
   - *Last Output*: the most recent sampled message it sent.
4. Use the refresh button on the card to re-fetch without changing selection.

Snapshots use a clean format: large payloads are summarised, but every placeholder includes the original length so you can judge the size at a glance. When a node is busier than the capture interval, the card shows how many newer messages went by since the sample was taken.

## Pausing/resuming capture
At the top of the Message Snapshot card you will find a **Capture snapshots** switch. Turning it off:
- Removes the runtime hooks from the message router.
- Clears previously stored snapshots.
- Changes the card status to “Snapshots paused. Enable capture to resume.”

Turn it back on whenever you are ready—the view refreshes automatically for the currently selected node.

## Inspecting snapshots over HTTP
If you prefer to script or automate, the plugin exposes a small admin API that mirrors the sidebar data (list nodes, inspect a specific node, get/set the capture settings, read runtime statistics). Details and example payloads live in [`docs/http-api.md`](docs/http-api.md).

## How it works
- Hooks into `onSend` (outputs) and `onReceive` (inputs) via `RED.hooks`, so every runtime node is observed without patching node prototypes.
- The hooks are one-argument synchronous handlers, the cheapest kind Node-RED supports. Per message they update a counter and a timestamp in a `Map` entry and return: no clock reads (`Date.now()` costs more than 1 µs on some VMs, so a coarse clock refreshed by an unref'd 50 ms timer is used instead), no allocation, no cloning, no serialisation.
- Everything runs inside `try/catch` and never returns a value: Node-RED treats a hook that throws, or returns `false`, as a reason to drop the message, so the plugin never does either. Hook errors are counted in the stats and logged at most once per minute.
- A snapshot is only taken when the node's capture interval has elapsed (default 250 ms per node and direction), when the global CPU budget for the current second is not spent (default 5 ms per second, i.e. at most 0.5 % of one core), and when the node did not recently produce a slow capture (a capture above 2 ms puts that node on a 10 s backoff).
- The snapshot walker never deep-clones or `JSON.stringify`s the message. It reads the message once with hard limits on depth, keys per object, items per array, string length, total values (`maxValues`) and total characters (`maxChars`), and it treats buffers, typed arrays, streams, sockets, HTTP request/response objects and promises as opaque placeholders. Its cost is independent of the size of buffers, strings and arrays.
- Snapshots, node metadata and timestamps live in memory, keyed by node id, and are pruned on every deploy.

## Measured overhead
Chain of 7 function nodes on a real Node-RED 4.1.8 runtime (`npm run bench`, Node 22, best of 3 runs, message with a 50-item detections array plus metadata):

| configuration | p50 latency per message | throughput (burst) | snapshots taken | avg / max snapshot cost |
|---|---|---|---|---|
| no plugin | 177 µs | 5607 msg/s | – | – |
| v1.0.0 (deep clone + stringify per hop) | 3287 µs | 306 msg/s | every hop | – |
| this version, defaults | 184 µs | 5200 msg/s | 24 for 2000 messages | 0.13 ms / 0.56 ms |
| this version, `captureInterval: 0`, `captureBudget: 0` (sample every message) | 500 µs | 1905 msg/s | 25478 | 0.03 ms / 5.2 ms |

Adding a 4 MB image buffer to every message does not change the numbers for this version (buffers are never copied or read); the previous version cloned the whole message twice per hop.

## Limitations & notes
- Snapshots live only in memory. Restarting Node-RED or redeploying flows clears them.
- Under sustained load a snapshot is a *sample*, not necessarily the very last message: check `inputSkipped`/`outputSkipped` and `lastInputSeenAt`/`lastOutputSeenAt` in the HTTP API to know how far behind it is. Set `captureInterval: 0` and `captureBudget: 0` while debugging a quiet flow if you need every message.
- `lastInputSeenAt`/`lastOutputSeenAt` have ~50 ms resolution; capture timestamps are exact.
- Nodes fed directly through `node.receive()` (the inject button, `link in` fed by `link out`, catch/status/complete nodes) are observed through the `onReceive` hook like any other node.
- Enumerating the keys of a very large dictionary (tens of thousands of keys in one object) is O(n) in V8 no matter how many keys are kept; such nodes are automatically sampled at most every 10 s.
- The HTTP routes require `flows.read` (GET) or `flows.write` (POST) permissions when admin authentication is enabled.
- Only runtime nodes that have processed a message since the plugin was enabled (plus the nodes of the deployed flows) appear.

## Development
```bash
npm test        # unit tests + end-to-end tests (the latter need a resolvable node-red: local, global, or NODE_RED_PATH)
npm run bench   # benchmark against a real Node-RED runtime; --mode none for the baseline, --payload small|medium|big
```
