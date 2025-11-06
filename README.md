# node-red-contrib-rosepetal-message-control

Runtime instrumentation for Node-RED that remembers the most recent message each node received and sent. The captured snapshots make it easier to understand what flows are doing without sprinkling debug nodes everywhere.

## What it does
- Hooks into the Node-RED runtime message pipeline via `RED.hooks` so every node's inbound and outbound traffic is observed.
- Stores a clone of the last inbound and outbound message plus timestamps, capped at 256 KB per snapshot.
- Surfaces the latest input/output directly inside the Editor's *Info* sidebar whenever you select a node, with an inline refresh button.
- Exposes lightweight HTTP endpoints so you can inspect the captured messages from the editor or any HTTP client. Only nodes that have seen traffic since the runtime started will appear in the responses.

## Installation
1. Change into your Node-RED user directory (typically `~/.node-red`).
2. Install the package:
   ```bash
   npm install node-red-contrib-rosepetal-message-control
   ```
3. Ensure the plugin is enabled. In `settings.js`, add or update the `plugins` section:
   ```js
   plugins: {
     'node-red-contrib-rosepetal-message-control': {
       enabled: true
     }
   }
   ```
4. Restart Node-RED.

> Node-RED v3.0 or later is required because the runtime hook API (`RED.hooks`) is what lets the plugin watch every node without patching their prototypes.

## HTTP endpoints
All routes are served from the Node-RED admin HTTP server and require the `flows.read` permission when admin auth is enabled.

- `GET /rosepetal/message-control/nodes`
  - Returns an array with the node id, type, name, and timestamps of the last seen inbound/outbound message.
- `GET /rosepetal/message-control/nodes/:id`
  - Returns the full snapshot for the given node id (including cloned message objects).

Example response:

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

If the captured payload serialises to more than 256 KB, the snapshot is truncated and replaced with a preview that notes the original length.

## Using the data in flows
Because the instrumentation patches nodes at runtime, no wiring changes are required. For scripted access you can call the HTTP endpoint from a Function node (via `http request`) or any external tool you prefer. Each restart clears the stored snapshots.

### Viewing snapshots in the editor
- Simply click a runtime node on the canvas: a floating **Message Snapshot** card pops up next to it and, if the *Info* sidebar is open, the same payloads appear there too.
- Use the refresh button on the card (or in the sidebar) to re-fetch the snapshot without reselecting the node.
- If the node hasn't processed traffic since the runtime started, you'll see a friendly notice instead of payload data.

## Limitations & notes
- Snapshots live in memory only; redeploying flows or restarting Node-RED clears them.
- Buffers and binary payloads are cloned; large blobs may be truncated.
- The plugin relies on internal runtime hook APIs, so new Node-RED releases might require future updates.
- Only messages processed after the plugin is enabled are visible.

## License
MIT
