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

var DebugLogtron = require('debug-logtron');

var HyperbahnClient = require('../../hyperbahn/index.js');

module.exports = runTests;

if (require.main === module) {
    runTests(require('../lib/hyperbahn-cluster.js'));
}

function runTests(HyperbahnCluster) {
    HyperbahnCluster.test('can advertise', {
        size: 5
    }, function t(cluster, assert) {
        var bob = cluster.remotes.bob;

        var client = new HyperbahnClient({
            serviceName: 'hello-bob',
            callerName: 'hello-bob-test',
            hostPortList: cluster.hostPortList,
            tchannel: bob.channel,
            logger: DebugLogtron('hyperbahnClient')
        });

        client.once('advertised', onResponse);
        client.advertise();

        function onResponse() {
            var result = client.latestAdvertisementResult;

            cluster.checkExitPeers(assert, {
                serviceName: 'hello-bob',
                hostPort: bob.channel.hostPort
            });

            assert.equal(result.head, null);

            // Because of duplicates in a size 5 cluster we know
            // that we have at most 5 kValues
            assert.ok(result.body.connectionCount <= 5,
                'expect to have at most 5 advertise results');

            client.destroy();
            assert.end();
        }
    });
}
