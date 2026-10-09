'use strict';

/*
 * Send a message to any node's input, exactly as a wire would deliver it
 * (node.receive), without temporary inject nodes. The message is delivered
 * on the next turn of the event loop so the admin request never runs the
 * node's code itself; errors in the node are handled by Node-RED as for any
 * message (node.error / catch nodes).
 */

class SendError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function createSender(RED) {
  function generateId() {
    if (RED.util && typeof RED.util.generateId === 'function') return RED.util.generateId();
    return (1 + Math.random() * 4294967295).toString(16).replace('.', '');
  }

  /**
   * @returns {{id, type, name, msgid, at}} at: runtime clock (ms) when the message was queued
   */
  function send(id, msg) {
    if (typeof id !== 'string' || !id) throw new SendError(400, 'invalid_request', 'id (node id) is required');
    const node = RED.nodes && typeof RED.nodes.getNode === 'function' ? RED.nodes.getNode(id) : null;
    if (!node) throw new SendError(404, 'unknown_node', `node ${id} is not running (unknown id, disabled, or on a disabled tab)`);
    if (typeof node.receive !== 'function') throw new SendError(409, 'no_input', `node ${id} cannot receive messages`);
    if (!node._inputCallback && !(Array.isArray(node._inputCallbacks) && node._inputCallbacks.length)) {
      throw new SendError(409, 'no_input', `node ${id} (${node.type}) has no input: it is a config node or a node without inputs`);
    }
    let message;
    if (msg === undefined || msg === null) message = {};
    else if (typeof msg === 'object' && !Array.isArray(msg)) message = msg;
    else throw new SendError(400, 'invalid_request', 'msg must be an object');
    if (!message._msgid) message._msgid = generateId();
    setImmediate(() => {
      try {
        node.receive(message);
      } catch (err) {
        try {
          node.error(err, message);
        } catch (ignored) {
          // nothing else to do
        }
      }
    });
    return { id, type: node.type, name: node.name || '', msgid: message._msgid, at: Date.now() };
  }

  return { send };
}

module.exports = { createSender, SendError };
