// Copyright (c) 2015 Uber Technologies, Inc.
//
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

var extend = require('xtend');
var CountedReadySignal = require('ready-signal/counted');
var test = require('tape');
var util = require('util');
var TChannel = require('../../channel.js');
var parallel = require('run-parallel');
var debugLogtron = require('debug-logtron');

module.exports = allocCluster;

function allocCluster(opts) {
    opts = opts || {};

    var host = 'localhost';
    var logger = debugLogtron('tchannel', {
        enabled: true
    });

    var cluster = {
        logger: logger,
        hosts: new Array(opts.numPeers),
        channels: new Array(opts.numPeers),
        destroy: destroy,
        ready: CountedReadySignal(opts.numPeers),
        assertCleanState: assertCleanState,
        connectChannels: connectChannels,
        connectChannelToChannels: connectChannelToChannels,
        timers: opts.timers
    };
    var channelOptions = extend({
        logger: logger
    }, opts.channelOptions || opts);

    for (var i = 0; i < opts.numPeers; i++) {
        createChannel(i);
    }

    return cluster;

    function assertCleanState(assert, expected) {
        cluster.channels.forEach(function eachChannel(chan, i) {
            var chanExpect = expected.channels[i];
            if (!chanExpect) {
                assert.fail(util.format('unexpected channel[%s]', i));
                return;
            }

            var peers = chan.peers.values();
            assert.equal(peers.length, chanExpect.peers.length, util.format(
                'channel[%s] should have %s peer(s)', i, chanExpect.peers.length));
            peers.forEach(function eachPeer(peer, j) {
                var peerExpect = chanExpect.peers[j];
                if (!peerExpect) {
                    assert.fail(util.format(
                        'unexpected channel[%s] peer[%s]', i, j));
                    return;
                }
                peer.connections.forEach(function eachConn(conn, k) {
                    var connExpect = peerExpect.connections[k];
                    if (!connExpect) {
                        assert.fail(util.format(
                            'unexpected channel[%s] peer[%s] conn[%s]', i, j, k));
                        return;
                    }
                    Object.keys(connExpect).forEach(function eachProp(prop) {
                        var desc = util.format(
                            'channel[%s] peer[%s] conn[%s] should .%s',
                            i, j, k, prop);

                        var pending = conn.ops.getPending();

                        switch (prop) {
                        case 'inReqs':
                            assert.equal(pending.in, connExpect.inReqs, desc);
                            break;
                        case 'outReqs':
                            assert.equal(pending.out, connExpect.outReqs, desc);
                            break;
                        default:
                            assert.equal(conn[prop], connExpect[prop], desc);
                        }
                    });
                });
            });
        });
    }

    function createChannel(i) {
        var chan = TChannel(extend(channelOptions));
        var port = opts.listen && opts.listen[i] || 0;
        chan.on('listening', chanReady);
        chan.listen(port, host);
        cluster.channels[i] = chan;

        function chanReady() {
            var port = chan.address().port;
            cluster.hosts[i] = util.format('%s:%s', host, port);
            cluster.ready.signal(cluster);
        }
    }

    function destroy(cb) {
        parallel(cluster.channels.map(function(chan) {
            return function(done) {
                if (!chan.destroyed) chan.quit(done);
            };
        }), cb);
    }
}

allocCluster.test = function testCluster(desc, opts, t) {
    if (opts === undefined) {
        return test(desc);
    }

    if (typeof opts === 'number') {
        opts = {
            numPeers: opts
        };
    }
    if (typeof opts === 'function') {
        t = opts;
        opts = {};
    }
    if (opts.timers && opts.channelOptions) {
        opts.channelOptions.timers = opts.timers;
    }
    test(desc, function t2(assert) {
        opts.assert = assert;
        allocCluster(opts).ready(function clusterReady(cluster) {
            assert.once('end', function testEnded() {
                cluster.destroy();
            });
            t(cluster, assert);
        });
    });
};

allocCluster.test.only = function testClusterOnly(desc, opts, t) {
    if (typeof opts === 'number') {
        opts = {
            numPeers: opts
        };
    }
    if (typeof opts === 'function') {
        t = opts;
        opts = {};
    }
    test.only(desc, function t2(assert) {
        opts.assert = assert;
        allocCluster(opts).ready(function clusterReady(cluster) {
            assert.once('end', function testEnded() {
                cluster.destroy();
            });
            t(cluster, assert);
        });
    });
};

function connectChannels(channels, callback) {
    return parallel(channels.map(function (channel) {
        return function connectChannelToHosts(callback) {
            return connectChannelToChannels(channel, channels, callback);
        };
    }), callback);
}

function connectChannelToChannels(channel, channels, callback) {
    return parallel(channels.map(function (peerChannel) {
        return function connectChannelToHost(callback) {
            if (channel.hostPort === peerChannel.hostPort) {
                return callback();
            }
            var peer = channel.peers.add(peerChannel.hostPort);
            var connection = peer.connect();
            connection.identifiedEvent.on(onIdentified);
            // TODO impl connect on self connect
            function onIdentified() {
                callback();
            }
        };
    }), callback);
}

allocCluster.Pool = require('./resource_pool');
