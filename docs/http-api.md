# HTTP API reference

The plugin exposes a small set of admin HTTP routes so you can inspect or control snapshots without using the editor UI. Every route lives on the Node-RED admin server (usually `http://localhost:1880`) and shares the base path `/rosepetal/message-control`.

## Authentication & permissions
- The routes honour Node-RED admin authentication.
- `GET` routes require the `flows.read` permission.
- `POST /settings` requires the `flows.write` permission.
- If CSRF protection is enabled, include the editor’s `_csrf` token when issuing `POST /settings`.

All responses are JSON. When something goes wrong you will see a payload shaped like:
```json
{ "error": "invalid_request", "message": "Human-readable explanation" }
```

## Data model overview
Each node entry contains:
- `id`, `type`, `name`: copied from the runtime node (or from the deployed flow configuration).
- `lastInput`, `lastOutput`: the cleaned snapshots. Buffers, typed arrays, streams/sockets/HTTP objects, base64 strings and data URLs collapse into `[Type withheld: size]` placeholders; long arrays keep the first items plus an `… N more items` note; objects with many keys keep the first ones plus `__rosepetalCleanTruncated` / `__rosepetalCleanNote`; long strings are cut with a `… [truncated N chars]` suffix; cycles become `[Circular]`. The whole snapshot is capped by `maxValues` (default 2000 values) and `maxChars` (default 256 KB of string content).
- `lastInputAt`, `lastOutputAt`: epoch milliseconds when the snapshots were captured (`null` if never captured).
- `lastOutputPort`, `lastOutputWired`: output port (0-based, as in the node's `wires` array) of the last output snapshot, and whether that port had wires. `lastOutputWired: false` means the message went nowhere: Node-RED drops messages sent to outputs without wires, the plugin still records them (setting `captureUnwired`).
- `lastInputSeenAt`, `lastOutputSeenAt`: epoch milliseconds of the most recent message observed in that direction, even when it was not snapshotted (≈50 ms resolution).
- `inputCount`, `outputCount`: messages observed since the plugin was enabled (outputs count `send` calls).
- `inputSkipped`, `outputSkipped`: messages observed since the current snapshot was taken. `0` means the snapshot is the latest message.
- `inputHistoryCount`, `outputHistoryCount`: snapshots currently kept in the history of each direction (see `?history`).

Snapshots are samples: a node is snapshotted at most once per `captureInterval` per direction, within the global `captureBudget`, so under load the snapshot may be older than the last message. Use the `*SeenAt` and `*Skipped` fields to tell.

## Endpoints

### `GET /rosepetal/message-control/nodes`
Lists every node known to the plugin (nodes of the deployed flows plus any runtime node that has processed a message).

**Response 200**
```json
[
  {
    "id": "d3f1a4b0.f6c0a8",
    "type": "function",
    "name": "Transform order",
    "lastInputAt": 1706811025123,
    "lastOutputAt": 1706811025125,
    "lastInputSeenAt": 1706811025400,
    "lastOutputSeenAt": 1706811025400,
    "inputCount": 12,
    "outputCount": 12
  }
]
```
Only metadata, counters and timestamps are returned here; request the node-specific endpoint to see the payload bodies.

### `GET /rosepetal/message-control/nodes/:id`
Fetches the full snapshot for a specific node id.

**Path parameter**
- `id` — Node-RED runtime id (the same string shown in the editor’s info panel).

**Query parameter**
- `history` (optional) — also return the history: up to this many snapshots per direction (`0`–`100`, larger values are clamped) or `all`. Without it the response has no history arrays.

With `?history=N` the response adds:
- `inputHistory`: `[{ "at": <epoch ms>, "seq": <inputCount at capture>, "msg": <snapshot> }, …]`, newest first.
- `outputHistory`: `[{ "at", "seq", "port", "wired", "msg" }, …]`, newest first. `wired: false` marks a message sent to an output without wires.
- `historyTruncated: true` when the snapshots did not fit in the response budget (about 2 MB); the newest ones are kept.

Gaps in `seq` are messages that were observed but not sampled (see `captureInterval` / `captureBudget`).

**Response 200**
```json
{
  "id": "d3f1a4b0.f6c0a8",
  "type": "function",
  "name": "Transform order",
  "lastInput": {
    "_msgid": "6f1c2e4d8a9b3c10",
    "payload": {
      "items": [ { "productId": "A1", "qty": 1 }, "… 244 more items" ],
      "image": "[Buffer withheld: 65536 bytes]",
      "notes": "Lorem ipsum… [truncated 3172 chars]"
    }
  },
  "lastInputAt": 1706811025123,
  "lastOutput": { "_msgid": "6f1c2e4d8a9b3c10", "payload": { "total": 245 } },
  "lastOutputAt": 1706811025125,
  "lastOutputPort": 0,
  "lastOutputWired": true,
  "lastInputSeenAt": 1706811025400,
  "lastOutputSeenAt": 1706811025400,
  "inputCount": 12,
  "outputCount": 12,
  "inputSkipped": 3,
  "outputSkipped": 3,
  "inputHistoryCount": 4,
  "outputHistoryCount": 4
}
```

**Response 200 with `?history=2`** (snapshots shortened)
```json
{
  "id": "d3f1a4b0.f6c0a8",
  "…": "same fields as above",
  "inputHistory": [
    { "at": 1706811025123, "seq": 12, "msg": { "_msgid": "6f1c2e4d8a9b3c10", "payload": { "items": [] } } },
    { "at": 1706811024870, "seq": 8, "msg": { "_msgid": "0b7e…", "payload": { "items": [] } } }
  ],
  "outputHistory": [
    { "at": 1706811025125, "seq": 12, "port": 0, "wired": true, "msg": { "payload": { "total": 245 } } },
    { "at": 1706811024872, "seq": 8, "port": 1, "wired": false, "msg": { "payload": { "error": "no stock" } } }
  ]
}
```

**Response 400** — `history` is not a non-negative integer or `all`.

**Response 404**
```json
{ "error": "unknown_node", "message": "No messages recorded for node <id>" }
```

### `GET /rosepetal/message-control/settings`
Returns the current capture settings so external tools know whether instrumentation is running.

**Response 200**
```json
{ "enabled": true, "captureInterval": 250, "captureBudget": 5, "historySize": 10, "historyMaxBytes": 16777216, "captureUnwired": true }
```

### `POST /rosepetal/message-control/settings`
Pause or resume capture, or change the sampling limits, at runtime.

**Request body** (every key optional, at least one required)
```json
{ "enabled": false, "captureInterval": 0, "captureBudget": 0, "historySize": 20, "historyMaxBytes": 33554432, "captureUnwired": true, "_csrf": "<token>" }
```
- `enabled` — `false` removes the hooks from the message router and clears all snapshots; `true` re-installs them.
- `captureInterval` — milliseconds between two snapshots of the same node and direction (0–3600000). `0` samples every message.
- `captureBudget` — milliseconds of snapshot CPU allowed per second across all nodes (0–1000). `0` disables the cap.
- `historySize` — snapshots kept per node and direction (0–100). `0` keeps only `lastInput`/`lastOutput`. Shrinking it drops the oldest snapshots immediately.
- `historyMaxBytes` — global budget, in estimated bytes, of all histories (0–1073741824). When exceeded, the oldest snapshots of any node are dropped first. `0` disables the history.
- `captureUnwired` — `true` records messages sent to outputs without wires; `false` restores Node-RED's own `send` on every node.
- `_csrf` is optional unless your Node-RED admin server enforces CSRF tokens.

**Response 200**
```json
{ "enabled": false, "captureInterval": 0, "captureBudget": 0, "historySize": 20, "historyMaxBytes": 33554432, "captureUnwired": true }
```

**Common error codes**
- `400 invalid_request` — body is missing/invalid, contains no recognised setting, or a value is out of range.
- `403 forbidden` — user lacks `flows.write` permission.
- `413 entity_too_large` — body larger than the 1 MB safety limit.

### `GET /rosepetal/message-control/stats`
Runtime statistics, useful to verify the plugin's cost on a live system.

**Response 200**
```json
{
  "version": "1.2.0",
  "enabled": true,
  "hooksInstalled": true,
  "clockRunning": true,
  "uptimeMs": 3600000,
  "nodes": 42,
  "inputsSeen": 120000,
  "outputsSeen": 118000,
  "captures": 1450,
  "skippedByInterval": 236000,
  "skippedByBudget": 550,
  "slowCaptures": 0,
  "captureMs": 38.2,
  "avgCaptureMs": 0.026,
  "maxCaptureMs": 0.9,
  "history": { "items": 380, "bytes": 2965504, "evicted": 0 },
  "unwired": { "active": true, "nodes": 7, "sends": 1520 },
  "errors": 0,
  "limits": { "maxDepth": 6, "maxArrayLength": 50, "maxObjectKeys": 60, "maxStringLength": 2048, "maxValues": 2000, "maxChars": 262144 }
}
```
- `captureMs` is the total CPU time spent taking snapshots since start; divide by `uptimeMs` for the duty cycle.
- `skippedByInterval` / `skippedByBudget` count messages that were observed but not snapshotted.
- `slowCaptures` counts snapshots that exceeded 2 ms (their node is then sampled at most every 10 s).
- `history` — snapshots currently kept in all histories, their estimated bytes, and how many were dropped by the `historyMaxBytes` budget.
- `unwired` — whether unwired-output capture is active, how many nodes currently use the send wrapper, and how many sends to outputs without wires were observed.
- `errors` counts hook invocations that hit an unexpected exception (the message was still delivered).

### `GET /rosepetal/message-control/logs`
The last lines of Node-RED's log, kept by the plugin in a ring buffer (`logBufferSize`, default 2000; levels up to `logLevel`, default `info`). Node construction errors only ever reach the log: look here when a node does not start.

**Query parameters** (all optional)
- `level` — most verbose level returned: `fatal`, `error`, `warn`, `info`, `debug`, `trace`.
- `text` — case-insensitive substring of the text, node name or node type (plain text, no regular expressions).
- `node` — node id; `type` — node type.
- `since`, `until` — epoch milliseconds.
- `limit` — newest matching entries returned (default 200, max 1000), oldest first.

**Response 200**
```json
{
  "entries": [
    { "seq": 41, "at": 1706811025123, "level": "error", "id": "d3f1a4b0", "type": "function", "name": "parse", "z": "tab1", "text": "SyntaxError: Unexpected identifier" }
  ],
  "matched": 1, "truncated": false, "buffered": 412, "bufferSize": 2000,
  "oldestAt": 1706810000000, "droppedBeforeOldest": 0, "captureLevel": "info"
}
```
Lines logged before the plugin loaded (the first lines of start-up) are not in the buffer.

### `GET /rosepetal/message-control/module-files`
Lists the files of an installed package (read-only).

**Query parameters**
- `module` (required) — npm package name installed in `userDir/node_modules` (e.g. `@acme/node-red-cameras`), or `node-red` for Node-RED's core nodes.
- `glob` — only paths matching it (`*`, `**`, `?`), e.g. `**/*.js`.
- `dependencies=true` — also walk nested `node_modules` (skipped by default).

**Response 200**
```json
{ "module": "@acme/node-red-cameras", "files": [ { "path": "nodes/camera.js", "size": 5120 } ], "complete": true, "notes": [], "skippedDependencies": true }
```

### `GET /rosepetal/message-control/module-files/search`
Plain-text search through the files of a package: `module`, `query` (required, plain text — no regular expressions), `caseSensitive=true`, `glob`, `dependencies=true`, `limit` (default 100, max 500).

**Response 200**
```json
{ "module": "@acme/node-red-cameras", "query": "timeout", "matches": [ { "path": "nodes/camera.js", "line": 42, "text": "  const timeout = 5000;" } ],
  "filesSearched": 12, "filesWithMatches": 1, "binarySkipped": 1, "truncated": false, "complete": true, "notes": [], "skippedDependencies": true }
```

### `GET /rosepetal/message-control/module-files/read`
Reads one file of a package: `module`, `path` (required, relative to the package), `from` / `to` (1-based lines, optional).

**Response 200**
```json
{ "module": "@acme/node-red-cameras", "path": "nodes/camera.js", "size": 5120, "totalLines": 180, "from": 40, "to": 44, "truncated": false, "text": "…" }
```

Limits and confinement: files above 4 MB cannot be read (2 MB for search), answers carry at most 200 KB of text (whole lines), a search visits at most 5000 files / 64 MB / 5 s. A path that leaves the package — `..`, or a symlink resolving outside its real directory — is refused (`400 invalid_path`, `403 outside_module`); binary files answer `415`. Requires `flows.read`; disabled with `moduleFiles: false`.

### `POST /rosepetal/message-control/send`
Delivers a message to the input of a running node, as a wire would (`node.receive`): no temporary inject node is needed. The message is delivered on the next turn of the event loop and the node processes it for real — everything it does downstream (outputs, writes, devices) happens. The plugin records it as the node's input like any other message.

**Request**
```json
{ "id": "d3f1a4b0", "msg": { "payload": 42, "topic": "test" }, "_csrf": "<token>" }
```
`msg` is optional (default `{}`); a `_msgid` is generated when missing.

**Response 202**
```json
{ "id": "d3f1a4b0", "type": "function", "name": "parse", "msgid": "6f1c2e4d8a9b3c10" }
```

**Errors**: `404 unknown_node` (not running: unknown id, disabled node or tab), `409 no_input` (config nodes and nodes without input), `400 invalid_request` (msg not an object). Requires `flows.write`; disabled with `sendToNode: false`.

## Tips for automation
- Use `GET /nodes` to build a dropdown list of active nodes, then query `GET /nodes/:id` on demand (add `?history=5` to see the last few messages).
- Poll `GET /settings` in companion tools to show when capture is paused.
- When tracing a single message through a quiet flow, temporarily `POST /settings` with `{ "captureInterval": 0, "captureBudget": 0 }` so every hop is sampled, then restore the defaults.
- Remember that snapshots reset on every Node-RED restart, so hit your flows with representative traffic before asserting on snapshot data.
