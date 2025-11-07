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
Each node snapshot contains:
- `id`, `type`, `name`: copied from the runtime node.
- `lastInput`, `lastOutput`: the cleaned payloads (buffers/base64 strings collapsed into placeholders, arrays summarised with `length` + sampled items, long strings truncated with explanatory notes).
- `lastInputAt`, `lastOutputAt`: epoch milliseconds when the payloads were captured (or `null` if never seen).

## Endpoints

### `GET /rosepetal/message-control/nodes`
Lists every runtime node that has processed a message since the plugin started.

**Response 200**
```json
[
  {
    "id": "d3f1a4b0.f6c0a8",
    "type": "function",
    "name": "Transform order",
    "lastInputAt": 1706811025123,
    "lastOutputAt": 1706811025125
  }
]
```
Only metadata and timestamps are returned here; request the node-specific endpoint to see the payload bodies.

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
  "lastInputAt": 1706811025123,
  "lastOutputAt": 1706811025125,
  "lastInput": {
    "__rosepetalArraySummary": true,
    "length": 245,
    "items": [
      { "productId": "A1", "qty": 1 }
    ],
    "__rosepetalCleanTruncated": true,
    "__rosepetalCleanNote": "244 more items not shown"
  },
  "lastOutput": {
    "payload": "[Buffer withheld: 65536 bytes]",
    "meta": {
      "$$truncated": true,
      "preview": "...",
      "originalLength": 420000
    }
  }
}
```

**Response 404**
```json
{ "error": "unknown_node", "message": "No messages recorded for node <id>" }
```

### `GET /rosepetal/message-control/settings`
Returns the current capture state so external tools know whether instrumentation is running.

**Response 200**
```json
{ "enabled": true }
```

### `POST /rosepetal/message-control/settings`
Allows you to pause or resume capture programmatically.

**Request body**
```json
{ "enabled": false, "_csrf": "<token>" }
```
`_csrf` is optional unless your Node-RED admin server enforces CSRF tokens.

**Response 200**
```json
{ "enabled": false }
```
When `enabled` changes from `true` to `false`, all stored snapshots are cleared immediately. Re-enabling restarts the hooks; new payloads will appear as soon as the monitored nodes process messages again.

**Common error codes**
- `400 invalid_request` — body is missing/invalid or exceeds 1 MB.
- `403 forbidden` — user lacks `flows.write` permission.
- `413 entity_too_large` — body larger than the 1 MB safety limit.

## Tips for automation
- Use `GET /nodes` to build a dropdown list of active nodes, then query `GET /nodes/:id` on demand.
- Poll `GET /settings` in companion tools to show when capture is paused.
- When integrating, remember that snapshots reset on every Node-RED restart, so hit your flows with representative traffic before asserting on snapshot data.
