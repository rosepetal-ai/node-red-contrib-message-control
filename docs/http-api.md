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
- `lastInputSeenAt`, `lastOutputSeenAt`: epoch milliseconds of the most recent message observed in that direction, even when it was not snapshotted (≈50 ms resolution).
- `inputCount`, `outputCount`: messages observed since the plugin was enabled (outputs count `send` calls).
- `inputSkipped`, `outputSkipped`: messages observed since the current snapshot was taken. `0` means the snapshot is the latest message.

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
  "lastInputSeenAt": 1706811025400,
  "lastOutputSeenAt": 1706811025400,
  "inputCount": 12,
  "outputCount": 12,
  "inputSkipped": 3,
  "outputSkipped": 3
}
```

**Response 404**
```json
{ "error": "unknown_node", "message": "No messages recorded for node <id>" }
```

### `GET /rosepetal/message-control/settings`
Returns the current capture settings so external tools know whether instrumentation is running.

**Response 200**
```json
{ "enabled": true, "captureInterval": 250, "captureBudget": 5 }
```

### `POST /rosepetal/message-control/settings`
Pause or resume capture, or change the sampling limits, at runtime.

**Request body** (every key optional, at least one required)
```json
{ "enabled": false, "captureInterval": 0, "captureBudget": 0, "_csrf": "<token>" }
```
- `enabled` — `false` removes the hooks from the message router and clears all snapshots; `true` re-installs them.
- `captureInterval` — milliseconds between two snapshots of the same node and direction (0–3600000). `0` samples every message.
- `captureBudget` — milliseconds of snapshot CPU allowed per second across all nodes (0–1000). `0` disables the cap.
- `_csrf` is optional unless your Node-RED admin server enforces CSRF tokens.

**Response 200**
```json
{ "enabled": false, "captureInterval": 0, "captureBudget": 0 }
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
  "errors": 0,
  "limits": { "maxDepth": 6, "maxArrayLength": 50, "maxObjectKeys": 60, "maxStringLength": 2048, "maxValues": 2000, "maxChars": 262144 }
}
```
- `captureMs` is the total CPU time spent taking snapshots since start; divide by `uptimeMs` for the duty cycle.
- `skippedByInterval` / `skippedByBudget` count messages that were observed but not snapshotted.
- `slowCaptures` counts snapshots that exceeded 2 ms (their node is then sampled at most every 10 s).
- `errors` counts hook invocations that hit an unexpected exception (the message was still delivered).

## Tips for automation
- Use `GET /nodes` to build a dropdown list of active nodes, then query `GET /nodes/:id` on demand.
- Poll `GET /settings` in companion tools to show when capture is paused.
- When tracing a single message through a quiet flow, temporarily `POST /settings` with `{ "captureInterval": 0, "captureBudget": 0 }` so every hop is sampled, then restore the defaults.
- Remember that snapshots reset on every Node-RED restart, so hit your flows with representative traffic before asserting on snapshot data.
