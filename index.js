// Copyright (c) 2015 Uber Technologies, Inc.

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

'use strict';

var v1 = require('./v1');
var nullLogger = require('./null-logger.js');
var globalClearTimeout = require('timers').clearTimeout;
var globalSetTimeout = require('timers').setTimeout;
var globalNow = Date.now;
var globalRandom = Math.random;
var net = require('net');
var format = require('util').format;
var inspect = require('util').inspect;

function TChannel(options) {
    if (!(this instanceof TChannel)) {
        return new TChannel(options);
    }

    var self = this;

    self.options = options || {};
    self.logger = self.options.logger || nullLogger;
    // TODO do not default the host.
    self.host = self.options.host || '127.0.0.1';
    // TODO do not default the port.
    self.port = self.options.port || 4040;
    self.hostPort = self.host + ':' + self.port;
    // TODO: maybe we should always add pid to user-supplied?
    self.processName = self.options.processName ||
        format('%s[%s]', process.title, process.pid);
    self.random = self.options.random ?
        self.options.random : globalRandom;
    self.setTimeout = self.options.timers ?
        self.options.timers.setTimeout : globalSetTimeout;
    self.clearTimeout = self.options.timers ?
        self.options.timers.clearTimeout : globalClearTimeout;
    self.now = self.options.timers ?
        self.options.timers.now : globalNow;

    self.reqTimeoutDefault = self.options.reqTimeoutDefault || 5000;
    self.serverTimeoutDefault = self.options.serverTimeoutDefault || 5000;
    self.timeoutCheckInterval = self.options.timeoutCheckInterval || 1000;
    self.timeoutFuzz = self.options.timeoutFuzz || 100;

    self.peers = Object.create(null);

    self.endpoints = Object.create(null);
    self.destroyed = false;
    // to provide backward compatibility.
    self.listening = self.options.listening === false ?
      false : true;
    self.serverSocket = new net.createServer(function onServerSocketConnection(sock) {
        if (!self.destroyed) {
            var remoteAddr = sock.remoteAddress + ':' + sock.remotePort;
            var conn = new TChannelConnection(self, sock, 'in', remoteAddr);
            self.logger.debug('incoming server connection', {
                hostPort: self.hostPort,
                remoteAddr: conn.remoteAddr
            });
        }
    });

    self.serverSocket.on('listening', function onServerSocketListening() {
        if (!self.destroyed) {
            self.logger.info(self.hostPort + ' listening');
            self.emit('listening');
        }
    });
    self.serverSocket.on('error', function onServerSocketError(err) {
        self.logger.error(self.hostPort + ' server socket error: ' + inspect(err));
    });
    self.serverSocket.on('close', function onServerSocketClose() {
        self.logger.warn('server socket close');
    });

    if (self.listening) {
        self.listen();
    }
}
require('util').inherits(TChannel, require('events').EventEmitter);

// Decoulping config and creation from the constructor.
// This also allows us to better unit test the code as the test process
// is not blocked by the listening connections
TChannel.prototype.listen = function listen() {
    var self = this;
    if (!self.serverSocket) {
        throw new Error('Missing server Socket.');
    }
    if (!self.host) {
        throw new Error('Missing server host.');
    }
    if (!self.port) {
        throw new Error('Missing server port.');
    }

    self.serverSocket.listen(self.port, self.host);
};

TChannel.prototype.getEndpointHandler = function getEndpointHandler(name) {
    var self = this;
    var handler = self.endpoints[name];
    if (typeof handler !== 'function') {
        handler = function noSuchHandler(arg2, arg3, remoteAddr, cb) {
            var err = new Error('no such operation'); // TODO: typed error
            err.op = name;
            cb(err, null, null);
        };
        self.emit('endpoint.missing', {
            name: name
        });
    } else if (self.endpoints[name]) {
        self.emit('endpoint', {
            name: name
        });
    }
    return handler;
};

TChannel.prototype.register = function register(op, callback) {
    var self = this;
    self.endpoints[op] = callback;
};

TChannel.prototype.setPeer = function setPeer(hostPort, conn) {
    var self = this;
    if (hostPort === self.hostPort) {
        throw new Error('refusing to set self peer');
    }

    var list = self.peers[hostPort];
    if (!list) {
        list = self.peers[hostPort] = [];
    }

    if (conn.direction === 'out') {
        list.unshift(conn);
    } else {
        list.push(conn);
    }
    return conn;
};

TChannel.prototype.getPeer = function getPeer(hostPort) {
    var self = this;
    var list = self.peers[hostPort];
    return list && list[0] ? list[0] : null;
};

TChannel.prototype.removePeer = function removePeer(hostPort, conn) {
    var self = this;
    var list = self.peers[hostPort];
    var index = list ? list.indexOf(conn) : -1;

    if (index === -1) {
        return;
    }

    // TODO: run (don't walk) away from "arrays" as peers, get to actual peer
    // objects... note how these current semantics can implicitly convert
    // an in socket to an out socket
    list.splice(index, 1);
};

TChannel.prototype.getPeers = function getPeers() {
    var self = this;
    var keys = Object.keys(self.peers);

    var peers = [];
    for (var i = 0; i < keys.length; i++) {
        var list = self.peers[keys[i]];

        for (var j = 0; j < list.length; j++) {
            peers.push(list[j]);
        }
    }

    return peers;
};

TChannel.prototype.addPeer = function addPeer(hostPort, connection) {
    var self = this;
    if (hostPort === self.hostPort) {
        throw new Error('refusing to add self peer');
    }

    if (!connection) {
        connection = self.makeOutConnection(hostPort);
    }

    var existingPeer = self.getPeer(hostPort);
    if (existingPeer !== null && existingPeer !== connection) { // TODO: how about === undefined?
        self.logger.warn('allocated a connection twice', {
            hostPort: hostPort,
            direction: connection.direction
            // TODO: more log context
        });
    }

    self.logger.debug('alloc peer', {
        source: self.hostPort,
        destination: hostPort,
        direction: connection.direction
        // TODO: more log context
    });
    connection.once('reset', function onConnectionReset(/* err */) {
        // TODO: log?
        self.removePeer(hostPort, connection);
    });
    connection.once('socketClose', function onConnectionSocketClose(conn, err) {
        self.emit('socketClose', conn, err);
    });
    return self.setPeer(hostPort, connection);
};

/* jshint maxparams:5 */
TChannel.prototype.send = function send(options, arg1, arg2, arg3, callback) {
    var self = this;
    if (self.destroyed) {
        throw new Error('cannot send() to destroyed tchannel');
    }

    var dest = options.host;
    if (!dest) {
        throw new Error('cannot send() without options.host');
    }

    var peer = self.getOutConnection(dest);
    peer.send(options, arg1, arg2, arg3, callback);
};
/* jshint maxparams:4 */

TChannel.prototype.getOutConnection = function getOutConnection(dest) {
    var self = this;
    var peer = self.getPeer(dest);
    if (!peer) {
        peer = self.addPeer(dest);
    }
    return peer;
};

TChannel.prototype.makeSocket = function makeSocket(dest) {
    var parts = dest.split(':');
    if (parts.length !== 2) {
        throw new Error('invalid destination');
    }
    var host = parts[0];
    var port = parts[1];
    var socket = net.createConnection({host: host, port: port});
    return socket;
};

TChannel.prototype.makeOutConnection = function makeOutConnection(dest) {
    var self = this;
    var socket = self.makeSocket(dest);
    var connection = new TChannelConnection(self, socket, 'out', dest);
    return connection;
};

TChannel.prototype.quit = function quit(callback) {
    var self = this;
    self.destroyed = true;
    var peers = self.getPeers();
    var counter = peers.length + 1;

    self.logger.debug('quitting tchannel', {
        hostPort: self.hostPort
    });

    peers.forEach(function eachPeer(conn) {
        var sock = conn.socket;
        sock.once('close', onClose);

        conn.clearTimeoutTimer();

        self.logger.debug('destroy channel for', {
            direction: conn.direction,
            peerRemoteAddr: conn.remoteAddr,
            peerRemoteName: conn.remoteName,
            fromAddress: sock.address()
        });
        conn.closing = true;
        conn.resetAll(new Error('shutdown from quit'));
        sock.end();
    });

    var serverSocket = self.serverSocket;
    if (serverSocket.address()) {
        closeServerSocket();
    } else {
        serverSocket.once('listening', closeServerSocket);
    }

    function closeServerSocket() {
        serverSocket.once('close', onClose);
        serverSocket.close();
    }

    function onClose() {
        if (--counter <= 0) {
            if (counter < 0) {
                self.logger.error('closed more sockets than expected', {
                    counter: counter
                });
            }
            if (typeof callback === 'function') {
                callback();
            }
        }
    }
};

function TChannelConnection(channel, socket, direction, remoteAddr) {
    var self = this;
    if (remoteAddr === channel.hostPort) {
        throw new Error('refusing to create self connection');
    }

    self.channel = channel;
    self.logger = self.channel.logger;
    self.socket = socket;
    self.direction = direction;
    self.remoteAddr = remoteAddr;
    self.timer = null;

    self.remoteName = null; // filled in by identify message

    // TODO: factor out an operation collection abstraction
    self.inOps = Object.create(null);
    self.inPending = 0;
    self.outOps = Object.create(null);
    self.outPending = 0;

    self.lastTimeoutTime = 0;
    self.closing = false;

    self.parser = new v1.Parser(self);
    self.handler = new v1.Handler(self.channel, {
        writeFrame: function writeFrame(frame, callback) {
            self._writeFrame(frame, callback);
        },
        // TODO: the op boundary is probably better handled by an operation
        // collection abstraction that the handler can submit to and then later
        // fulfill to
        runInOp: function runInOp(handler, options, sendResponseFrame) {
            self.runInOp(handler, options, sendResponseFrame);
        },
        completeOutOp: function completeOutOp(err, id, res1, res2) {
            self.completeOutOp(id, err, res1, res2);
        }
    });

    self.socket.setNoDelay(true);

    self.socket.on('data', function onSocketData(chunk) {
        if (!self.closing) {
            self.parser.execute(chunk);
        }
    });
    self.socket.on('error', function onSocketError(err) {
        self.onSocketErr(err);
    });
    self.socket.on('close', function onSocketClose() {
        self.onSocketErr(new Error('socket closed'));
    });

    self.parser.on('frame', function onParserFrame(frame) {
        if (!self.closing) {
            self.onFrame(frame);
        }
    });
    self.parser.on('error', function onParserError(err) {
        if (!self.closing) {
            self.onParserError(err);
        }
    });

    self.handler.on('error', function onHandlerError(err) {
        self.resetAll(err);
    });

    if (direction === 'out') {
        self.handler.sendInitRequest();
        self.handler.once('identify.out', function onOutIdentified(hostPort) {
            self.remoteName = hostPort;
            self.channel.emit('identified', hostPort);
        });
    } else {
        self.handler.once('identify.in', function onInIdentified(hostPort) {
            self.remoteName = hostPort;
            self.channel.addPeer(hostPort, self);
            self.channel.emit('identified', hostPort);
        });
    }

    self.startTimeoutTimer();

    socket.once('close', clearTimer);

    function clearTimer() {
        self.channel.clearTimeout(self.timer);
    }
}
require('util').inherits(TChannelConnection, require('events').EventEmitter);

TChannelConnection.prototype.onParserError = function onParserError(err) {
    var self = this;
    self.channel.logger.error('tchannel parse error', {
        remoteName: self.remoteName,
        localName: self.channel.hostPort,
        error: err
    });
    // TODO should we close the connection?
};

// timeout check runs every timeoutCheckInterval +/- some random fuzz. Range is from
//   base - fuzz/2 to base + fuzz/2
TChannelConnection.prototype.getTimeoutDelay = function getTimeoutDelay() {
    var self = this;
    var base = self.channel.timeoutCheckInterval;
    var fuzz = self.channel.timeoutFuzz;
    return base + Math.round(Math.floor(self.channel.random() * fuzz) - (fuzz / 2));
};

TChannelConnection.prototype.startTimeoutTimer = function startTimeoutTimer() {
    var self = this;
    self.timer = self.channel.setTimeout(function onChannelTimeout() {
        // TODO: worth it to clear the fired self.timer objcet?
        self.onTimeoutCheck();
    }, self.getTimeoutDelay());
};

TChannelConnection.prototype.clearTimeoutTimer = function clearTimeoutTimer() {
    var self = this;
    if (self.timer) {
        self.channel.clearTimeout(self.timer);
        self.timer = null;
    }
};

// If the connection has some success and some timeouts, we should probably leave it up,
// but if everything is timing out, then we should kill the connection.
TChannelConnection.prototype.onTimeoutCheck = function onTimeoutCheck() {
    var self = this;
    if (self.closing) {
        return;
    }

    if (self.lastTimeoutTime) {
        self.logger.warn(self.channel.hostPort + ' destroying socket from timeouts');
        self.socket.destroy();
        return;
    }

    self.checkOutOpsForTimeout(self.outOps);
    self.checkInOpsForTimeout(self.inOps);

    self.startTimeoutTimer();
};

TChannelConnection.prototype.checkInOpsForTimeout = function checkInOpsForTimeout(ops) {
    var self = this;
    var opKeys = Object.keys(ops);
    var now = self.channel.now();

    for (var i = 0; i < opKeys.length; i++) {
        var opKey = opKeys[i];
        var op = ops[opKey];

        if (op === undefined) {
            continue;
        }

        var timeout = self.channel.serverTimeoutDefault;
        var duration = now - op.start;
        if (duration > timeout) {
            delete ops[opKey];
            self.inPending--;
        }
    }
};

TChannelConnection.prototype.checkOutOpsForTimeout = function checkOutOpsForTimeout(ops) {
    var self = this;
    var opKeys = Object.keys(ops);
    var now = self.channel.now();
    for (var i = 0; i < opKeys.length ; i++) {
        var opKey = opKeys[i];
        var op = ops[opKey];
        if (op.timedOut) {
            delete ops[opKey];
            self.outPending--;
            self.logger.warn('lingering timed-out outgoing operation');
            continue;
        }
        if (op === undefined) {
            // TODO: why not null and empty string too? I mean I guess false
            // and 0 might be a thing, but really why not just !op?
            self.channel.logger
                .warn('unexpected undefined operation', {
                    key: opKey,
                    op: op
                });
            continue;
        }
        var timeout = op.options.timeout || self.channel.reqTimeoutDefault;
        var duration = now - op.start;
        if (duration > timeout) {
            delete ops[opKey];
            self.outPending--;
            self.onReqTimeout(op);
        }
    }
};

TChannelConnection.prototype.onReqTimeout = function onReqTimeout(op) {
    var self = this;
    op.timedOut = true;
    op.callback(new Error('timed out'), null, null);
    self.lastTimeoutTime = self.channel.now();
};

// this socket is completely broken, and is going away
// In addition to erroring out all of the pending work, we reset the state in case anybody
// stumbles across this object in a core dump.
TChannelConnection.prototype.resetAll = function resetAll(err) {
    var self = this;
    if (self.closing) return;
    self.closing = true;

    var inOpKeys = Object.keys(self.inOps);
    var outOpKeys = Object.keys(self.outOps);

    self.logger[err ? 'warn' : 'info']('resetting connection', {
        error: err,
        remoteName: self.remoteName,
        localName: self.channel.hostPort,
        numInOps: inOpKeys.length,
        numOutOps: outOpKeys.length,
        inPending: self.inPending,
        outPending: self.outPending
    });

    self.clearTimeoutTimer();

    self.emit('reset');

    // requests that we've received we can delete, but these reqs may have started their
    //   own outgoing work, which is hard to cancel. By setting this.closing, we make sure
    //   that once they do finish that their callback will swallow the response.
    inOpKeys.forEach(function eachInOp(id) {
        // TODO: we could support an op.cancel opt-in callback
        delete self.inOps[id];
    });

    // for all outgoing requests, forward the triggering error to the user callback
    outOpKeys.forEach(function eachOutOp(id) {
        var op = self.outOps[id];
        delete self.outOps[id];
        // TODO: shared mutable object... use Object.create(err)?
        op.callback(err, null, null);
    });

    self.inPending = 0;
    self.outPending = 0;

    self.emit('socketClose', self, err);
};

TChannelConnection.prototype.onSocketErr = function onSocketErr(err) {
    var self = this;
    if (!self.closing) {
        self.resetAll(err);
    }
};

TChannelConnection.prototype.onFrame = function onFrame(frame) {
    var self = this;
    self.lastTimeoutTime = 0;
    self.handler.handleFrame(frame);
};

TChannelConnection.prototype.completeOutOp = function completeOutOp(id, err, arg1, arg2) {
    var self = this;
    var op = self.outOps[id];
    if (!op) {
        // TODO else case. We should warn about an incoming response for an
        // operation we did not send out.  This could be because of a timeout
        // or could be because of a confused / corrupted server.
        return;
    }
    delete self.outOps[id];
    self.outPending--;
    op.callback(err, arg1, arg2);
};

// send a req frame
/* jshint maxparams:5 */
TChannelConnection.prototype.send = function send(options, arg1, arg2, arg3, callback) {
    var self = this;
    // TODO: use this to protect against >4Mi outstanding messages edge case
    // (e.g. zombie operation bug, incredible throughput, or simply very long
    // timeout
    // if (self.outOps[id]) {
    //  throw new Error('duplicate frame id in flight');
    // }

    var id = self.handler.sendRequestFrame({
        arg1: arg1,
        arg2: arg2,
        arg3: arg3
    }, function requestSent(err) {
        if (err) {
            self.logger.warn('failed to send request', {
                id: id,
                error: err
            });
            // TODO: retry?
            // TODO: early self.completeOutOp(id, err, null, null)?
        }
    });

    self.outOps[id] = new TChannelClientOp(
        options, self.channel.now(), callback);
    self.pendingCount++;
};
/* jshint maxparams:4 */

TChannelConnection.prototype.runInOp = function runInOp(handler, options, sendResponseFrame) {
    var self = this;
    var id = options.id;
    self.inPending++;
    var op = self.inOps[id] = new TChannelServerOp(self,
        handler, self.channel.now(), options, opDone);

    function opDone(err, res1, res2) {
        if (self.inOps[id] !== op) {
            self.logger.warn('attempt to send frame for mismatched operation', {
                hostPort: self.channel.hostPort,
                opId: id
            });
            return;
        }
        sendResponseFrame(err, res1, res2, function responseSent(err) {
            if (err) {
                self.logger.warn('failed to send response', {
                    id: id,
                    error: err
                });
                // TODO: retry
            }
            delete self.inOps[id];
            self.inPending--;
        });
    }
};

TChannelConnection.prototype._writeFrame = function _writeFrame(frame, callback) {
    var self = this;
    if (self.closing) {
        self.logger.warn('write frame after close', {
            hostPort: self.channel.hostPort,
            remoteAddr: self.remoteAddr
        });
        if (callback) {
            callback(new Error('socket closing'));
        }
    } else {
        var buffer = frame.toBuffer();
        self.socket.write(buffer, null, callback);
    }
};

/* jshint maxparams:6 */
function TChannelServerOp(connection, handler, start, options, callback) {
    var self = this;
    self.options = options;
    self.connection = connection;
    self.logger = connection.logger;
    self.handler = handler;
    self.timedOut = false;
    self.start = start;
    self.callback = callback;
    self.responseSent = false;
    process.nextTick(function runHandler() {
        self.handler(self.options.arg2, self.options.arg3, connection.remoteName, sendResponse);
    });
    function sendResponse(err, res1, res2) {
        self.sendResponse(err, res1, res2);
    }
}
/* jshint maxparams:4 */

TChannelServerOp.prototype.sendResponse = function sendResponse(err, res1, res2) {
    var self = this;
    if (self.responseSent) {
        self.logger.error('response already sent', {
            err: err,
            res1: res1,
            res2: res2
        });
        return;
    }
    self.responseSent = true;
    // TODO: observability hook for handler errors
    self.callback(err, res1, res2);
};

function TChannelClientOp(options, start, callback) {
    var self = this;
    self.options = options;
    self.callback = callback;
    self.start = start;
    self.timedOut = false;
}

module.exports = TChannel;
