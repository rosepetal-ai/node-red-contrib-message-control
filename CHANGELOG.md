# Changelog

## 1.3.0 (unreleased)

### Added
- `GET /rosepetal/message-control/logs`: the last lines of Node-RED's log, in a fixed ring filled by a `RED.log` handler. Each entry is structured (`level`, node `id`/`type`/`name`/`z`, text), and the endpoint filters by level, text, node, type and time. Settings `logBufferSize` (default 2000) and `logLevel` (default `info`). Node construction errors only ever reach the log, so this is where to find them.

## 1.2.0

### Added
- Short history per node and direction: `GET /rosepetal/message-control/nodes/:id?history=N` (or `all`) returns the last sampled messages newest first, each with its capture time (`at`), sequence number (`seq`, gaps are unsampled messages) and, for outputs, `port` and `wired`. Responses are capped at about 2 MB (`historyTruncated`).
- Sends to outputs without wires are recorded. Node-RED drops them before the `onSend` hook runs (a node without wires gets a no-op `send`); only nodes with an unwired output get a `send` wrapper, fully wired nodes are untouched.
- Settings `historySize` (default 10, 0–100), `historyMaxBytes` (default 16 MB, global budget, oldest snapshots dropped first) and `captureUnwired` (default true), in `settings.js` and `POST /settings`.
- Node fields `lastOutputPort`, `lastOutputWired`, `inputHistoryCount`, `outputHistoryCount`.
- `GET /stats` reports `version`, `history` (items, bytes, evicted) and `unwired` (active, nodes, sends).
- The editor sidebar says when the last output went to an output without wires.

### Changed
- `GET /settings` and `POST /settings` responses include the new settings.
- Disabling capture also restores Node-RED's own `send` and `updateWires`.
