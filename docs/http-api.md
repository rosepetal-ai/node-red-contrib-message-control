---
title: "HTTP API Reference - Message Control"
description: "Admin HTTP routes of the Message Control plugin for Node-RED: last messages and history of every node, capture settings, statistics, the runtime log, files of installed packages and sending a message to a node. Part of @rosepetal/node-red-contrib-message-control."
sidebar_label: "HTTP API"
head:
  - - meta
    - name: "keywords"
      content: "node-red, message control, HTTP API, admin API, message snapshot, message history, runtime log, module files, send message, rosepetal"
  - - meta
    - property: "og:title"
      content: "HTTP API Reference - @rosepetal/node-red-contrib-message-control"
  - - meta
    - property: "og:description"
      content: "Admin HTTP routes of the Message Control plugin for Node-RED: snapshots and history, capture settings, statistics, runtime log, module files and sending a message to a node."
---

# HTTP API reference

The plugin exposes a small set of admin HTTP routes so you can inspect or control snapshots without using the editor UI. Every route lives on the Node-RED admin server (usually `http://localhost:1880`, under `httpAdminRoot` when it is set) and shares the base path `/rosepetal/message-control`.

## Authentication & permissions
- The routes honour Node-RED admin authentication (`adminAuth`): send the admin access token in an `Authorization: Bearer` header.
- `GET` routes require the `flows.read` permission.
- `POST /settings` and `POST /send` require the `flows.write` permission.
- A request without the permission gets Node-RED's `401`, with an empty body.
- `POST` bodies are JSON, sent with `Content-Type: application/json`: Node-RED's admin server parses them before the plugin sees them.

Errors raised by the plugin are JSON, shaped like:
```json
{ "error": "invalid_request", "message": "Human-readable explanation" }
```
The `401` above, and the answer to a body that is not valid JSON (`400`) or is larger than Node-RED's `apiMaxLength` setting (`413`, 5 MB by default), come from Node-RED itself and are not in this shape.

## Data model overview
Each node entry contains:
- `id`, `type`, `name`: copied from the runtime node (or from the deployed flow configuration).
- `lastInput`, `lastOutput`: the snapshots, in the format described under [Snapshot format](#snapshot-format) (`null` if never captured).
- `lastInputAt`, `lastOutputAt`: epoch milliseconds when the snapshots were captured (`null` if never captured).
- `lastOutputPort`, `lastOutputWired`: output port (0-based, as in the node's `wires` array) of the last output snapshot, and whether that port had wires. `lastOutputWired: false` means the message went nowhere: Node-RED drops messages sent to outputs without wires, the plugin still records them (setting `captureUnwired`).
- `lastInputSeenAt`, `lastOutputSeenAt`: epoch milliseconds of the most recent message observed in that direction, even when it was not snapshotted (≈50 ms resolution).
- `inputCount`, `outputCount`: messages observed since the capture was enabled (outputs count `send` calls).
- `inputSkipped`, `outputSkipped`: messages observed since the current snapshot was taken. `0` means the snapshot is the latest message.
- `inputHistoryCount`, `outputHistoryCount`: snapshots currently kept in the history of each direction (see `?history`).

Snapshots are samples: a node is snapshotted at most once per `captureInterval` per direction, within the global `captureBudget`, so under load the snapshot may be older than the last message. Use the `*SeenAt` and `*Skipped` fields to tell.

### Snapshot format
A snapshot is a bounded copy of the message, made by reading it once. Values that would be large, or that cannot be written as JSON, are replaced. The limits are the `snapshotLimits` of `settings.js`; the table shows their defaults.

| In the message | In the snapshot |
|----------------|-----------------|
| `Buffer`, or its JSON form `{ "type": "Buffer", "data": [...] }` | `"[Buffer withheld: 65536 bytes]"` |
| Typed array (`Uint8Array`, `Float32Array`...), `DataView`, `ArrayBuffer` | `"[Uint8Array withheld: 1024 items]"`; `DataView` and `ArrayBuffer` in bytes |
| String of 512 characters or more that starts with `data:image/` | `"[DataImage withheld: 90000 chars]"` |
| String of 512 characters or more that looks like base64 (length a multiple of 4; its first 512 characters are all base64 characters and include upper and lower case letters and digits) | `"[Base64 withheld: 90000 chars]"` |
| Any other string longer than `maxStringLength` (2048) | Its first 2048 characters, then `… [truncated 3172 chars]` |
| Stream, socket, HTTP request or response, any other event emitter | `"[Socket withheld: event emitter]"`, with the object's class name |
| `Map`, `Set` | `"[Map withheld: 3 entries]"` |
| Array longer than `maxArrayLength` (50) | Its first 50 items, then `"… 195 more items"` |
| Object with more than `maxObjectKeys` (60) keys | Its first 60 keys, plus `"__rosepetalCleanTruncated": true` and `"__rosepetalCleanNote": "12 more keys not shown"` |
| Object or array 6 levels below `msg` (`maxDepth`) | `"[Object with 4 keys]"`, `"[Array(10)]"` |
| Reference back to an enclosing object | `"[Circular]"` |
| `Date` | ISO 8601 string |
| Function, promise | `"[Function name]"`, `"[Promise]"` |

Two budgets apply to the whole snapshot: after `maxValues` (2000) values the rest is left out (`"[… truncated]"`, or a note at the end of the array or object), and once `maxChars` (262144) string characters are kept, further strings become `"[String withheld: 5000 chars]"`.

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
- `history` (optional) — also return the history: up to this many snapshots per direction (`0`–`100`, larger values are clamped) or `all`. Without it, or with `0`, the response has no history arrays.

With `?history=N` the response adds:
- `inputHistory`: `[{ "at": <epoch ms>, "seq": <inputCount at capture>, "msg": <snapshot> }, …]`, newest first.
- `outputHistory`: `[{ "at", "seq", "port", "wired", "msg" }, …]`, newest first. `wired: false` marks a message sent to an output without wires.
- `historyTruncated: true` when the snapshots did not fit in the response budget (about 2 MB); the newest ones are kept.

Gaps in `seq` are messages that were observed but not sampled (see `captureInterval` / `captureBudget`).

A node of the deployed flows that has not processed a message yet answers `200` with `null` snapshots and zero counters.

**Response 200** (snapshot shortened: `items` keeps its first 50 entries before the `… 195 more items` note, and `notes` its first 2048 characters)
```json
{
  "id": "d3f1a4b0.f6c0a8",
  "type": "function",
  "name": "Transform order",
  "lastInput": {
    "_msgid": "6f1c2e4d8a9b3c10",
    "payload": {
      "items": [ { "productId": "A1", "qty": 1 }, "… 195 more items" ],
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

**Response 400** — `history` is not a non-negative integer or `all`:
```json
{ "error": "invalid_request", "message": "history must be an integer between 0 and 100, or \"all\"" }
```

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
{ "enabled": false, "captureInterval": 0, "captureBudget": 0, "historySize": 20, "historyMaxBytes": 33554432, "captureUnwired": true }
```
- `enabled` — `false` removes the hooks from the message router and clears all snapshots; `true` re-installs them.
- `captureInterval` — milliseconds between two snapshots of the same node and direction (0–3600000, larger values are clamped). `0` samples every message.
- `captureBudget` — milliseconds of snapshot CPU allowed per second across all nodes (0–1000, larger values are clamped). `0` disables the cap.
- `historySize` — snapshots kept per node and direction (0–100; decimals are rounded down). `0` keeps only `lastInput`/`lastOutput`. Shrinking it drops the oldest snapshots immediately.
- `historyMaxBytes` — global budget, in estimated bytes, of all histories (0–1073741824). When exceeded, the oldest snapshots of any node are dropped first. `0` disables the history.
- `captureUnwired` — `true` records messages sent to outputs without wires; `false` restores Node-RED's own `send` on every node.

Send `enabled` and `captureUnwired` as JSON booleans: any other value is read as true or false the JavaScript way, so the string `"false"` counts as `true`. The numbers may also be numeric strings. Other keys are ignored. The changes last until Node-RED restarts.

**Response 200** — the settings now in effect:
```json
{ "enabled": false, "captureInterval": 0, "captureBudget": 0, "historySize": 20, "historyMaxBytes": 33554432, "captureUnwired": true }
```

**Errors**
- `400 invalid_request` — the body has no recognised setting (`No valid setting provided`), or a number is negative, not a number, or above the maximum of `historySize` / `historyMaxBytes` (the message names the setting, and nothing is changed).
- `401` — the user lacks the `flows.write` permission.

### `GET /rosepetal/message-control/stats`
Runtime statistics, useful to verify the plugin's cost on a live system.

**Response 200**
```json
{
  "version": "1.3.0",
  "features": ["history", "unwired", "logs", "module-files", "send"],
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
- `features` lists what this version and configuration offer: `history`, `unwired` and `logs` always, `module-files` and `send` unless they are disabled with `moduleFiles: false` / `sendToNode: false`.
- `captureMs` is the total CPU time spent taking snapshots since start; divide by `uptimeMs` for the duty cycle.
- `skippedByInterval` / `skippedByBudget` count messages that were observed but not snapshotted.
- `slowCaptures` counts snapshots that exceeded 2 ms (their node is then sampled at most every 10 s).
- `history` — snapshots currently kept in all histories, their estimated bytes, and how many were dropped by the `historyMaxBytes` budget.
- `unwired` — whether unwired-output capture is active, how many nodes currently use the send wrapper, and how many sends to outputs without wires were observed.
- `errors` counts hook invocations that hit an unexpected exception (the message was still delivered).

### `GET /rosepetal/message-control/logs`
The last lines of Node-RED's log, kept by the plugin in a ring buffer (`logBufferSize`, default 2000; levels up to `logLevel`, default `info`). The errors a node raises while it is created at deploy time (a function node whose code does not compile, for example) are logged with the node's id and type: look here when a node does not start. The buffer is filled whether the capture is enabled or paused.

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
- Each entry has its order number (`seq`), time (`at`, epoch milliseconds) and `level`; `id`, `type`, `name` and `z` (its flow) when a node logged it; and `text`, at most 2000 characters (then `… [truncated N chars]`). An error is written as `Name: message` followed by the first frame of its stack in parentheses, an object as the JSON of its snapshot.
- `matched` counts every matching entry; `truncated` is `true` when more matched than `limit`.
- `buffered` and `bufferSize` are the entries kept and the size of the ring; `droppedBeforeOldest` counts the entries overwritten since start; `captureLevel` is the `logLevel` in effect.

Lines logged before the plugin loaded (the first lines of start-up) are not in the buffer. With `logBufferSize: 0` nothing is kept and `entries` is always empty.

### `GET /rosepetal/message-control/module-files`
Lists the files of an installed package (read-only).

**Query parameters**
- `module` (required) — npm package name installed in `userDir/node_modules` (e.g. `@acme/node-red-cameras`), or `node-red` (also `@node-red/nodes`) for Node-RED's core nodes.
- `glob` — only paths matching it, e.g. `**/*.js`: `*` and `?` stay within one folder, `**` crosses folders. At most 200 characters.
- `dependencies=true` — also walk nested `node_modules` (skipped by default).

Folders whose name starts with a dot (`.git`, `.github`) and symbolic links are left out of listings and searches.

**Response 200**
```json
{ "module": "@acme/node-red-cameras", "files": [ { "path": "nodes/camera.js", "size": 5120 } ], "complete": true, "notes": [], "skippedDependencies": true }
```
`skippedDependencies` is `true` when a nested `node_modules` was left out. A listing stops after visiting 5000 files, after 5 seconds, or at 2000 files listed; it then answers `complete: false` with the reason in `notes`.

### `GET /rosepetal/message-control/module-files/search`
Plain-text search through the files of a package: `module`, `query` (required, plain text — no regular expressions), `caseSensitive=true`, `glob`, `dependencies=true`, `limit` (default 100, max 500).

**Response 200**
```json
{ "module": "@acme/node-red-cameras", "query": "timeout", "matches": [ { "path": "nodes/camera.js", "line": 42, "text": "  const timeout = 5000;" } ],
  "filesSearched": 12, "filesWithMatches": 1, "binarySkipped": 1, "truncated": false, "complete": true, "notes": [], "skippedDependencies": true }
```
- Each match gives the file, the line number and the line, cut at 300 characters.
- Files larger than 2 MB are skipped. Binary files (without a known text extension and with a zero byte in their first 8000 bytes) are counted in `binarySkipped`.
- `truncated: true` means `limit` matches were found and the search stopped there.
- A search stops after visiting 5000 files, reading 64 MB or 5 seconds (`complete: false`, reason in `notes`).

### `GET /rosepetal/message-control/module-files/read`
Reads one file of a package: `module`, `path` (required, relative to the package), `from` / `to` (first and last line, 1-based, optional; the whole file by default).

**Response 200**
```json
{ "module": "@acme/node-red-cameras", "path": "nodes/camera.js", "size": 5120, "totalLines": 180, "from": 40, "to": 44, "truncated": false, "text": "…" }
```
At most 204800 characters of text are returned, in whole lines: when the range is longer, `truncated` is `true` and `to` is the last line returned.

**Errors of the three routes**

| Status | `error` | When |
|--------|---------|------|
| 400 | `invalid_module` | `module` is missing or is not an npm package name |
| 404 | `unknown_module` | The package is not installed in `userDir/node_modules` |
| 400 | `invalid_glob` | `glob` is longer than 200 characters |
| 400 | `invalid_query` | `query` is missing (search) |
| 400 | `invalid_path` | `path` is missing or leaves the package (`..`, an absolute path) |
| 404 | `not_found` | `path` does not exist in the package |
| 403 | `outside_module` | `path` is a symbolic link that resolves outside the package's real directory |
| 400 | `not_a_file` | `path` is a folder |
| 413 | `too_large` | The file is larger than 4 MB (read) |
| 415 | `binary` | The file is binary (read) |

Requires `flows.read`. With `moduleFiles: false` the three routes do not exist.

### `POST /rosepetal/message-control/send`
Delivers a message to the input of a running node, as a wire would (`node.receive`): no temporary inject node is needed. The message is delivered on the next turn of the event loop and the node processes it for real — everything it does downstream (outputs, writes, devices) happens. While the capture is enabled, the plugin records it as the node's input like any other message.

**Request**
```json
{ "id": "d3f1a4b0", "msg": { "payload": 42, "topic": "test" } }
```
`id` (the node id) is required. `msg` is optional (default `{}`) and must be an object; a `_msgid` is generated when missing.

**Response 202**
```json
{ "id": "d3f1a4b0", "type": "function", "name": "parse", "msgid": "6f1c2e4d8a9b3c10", "at": 1706811025123 }
```
`at` is the runtime's clock (epoch milliseconds) when the message was queued: use it as `since` for `GET /logs`.

**Errors**: `400 invalid_request` (`id` missing, or `msg` not an object), `404 unknown_node` (not running: unknown id, disabled node or tab), `409 no_input` (config nodes and nodes without input). Requires `flows.write`. With `sendToNode: false` the route does not exist.

## Tips for automation
- Use `GET /nodes` to build a dropdown list of active nodes, then query `GET /nodes/:id` on demand (add `?history=5` to see the last few messages).
- Poll `GET /settings` in companion tools to show when capture is paused.
- When tracing a single message through a quiet flow, temporarily `POST /settings` with `{ "captureInterval": 0, "captureBudget": 0 }` so every hop is sampled, then restore the defaults.
- Remember that snapshots reset on every Node-RED restart, so hit your flows with representative traffic before asserting on snapshot data.
