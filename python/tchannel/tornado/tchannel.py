# Copyright (c) 2015 Uber Technologies, Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
# THE SOFTWARE.

from __future__ import absolute_import

import logging
import threading
import weakref

import tornado.ioloop
import tornado.iostream

from ..exceptions import InvalidMessageException
from ..messages import CallRequestMessage
from .connection import TornadoConnection
from .timeout import timeout
from .server import TChannelServer

log = logging.getLogger('tchannel')


class TChannel(object):
    """Manages inbound and outbound connections to various hosts."""

    # We don't want to duplicate outgoing connections, so all instances of this
    # class will be a singleton.
    _singleton = threading.local()

    def __new__(cls):
        if hasattr(cls._singleton, "instance"):
            return cls._singleton.instance
        return super(TChannel, cls).__new__(cls)

    def __init__(self):
        self.peers = {}

        self._singleton.instance = self

    def add_peer(self, hostport):
        if hostport not in self.peers:
            self.peers[hostport] = TornadoConnection.outgoing(hostport)
        return self.peers[hostport]

    def remove_peer(self, hostport):
        # TODO: Connection cleanup
        return self.peers.pop(hostport)

    def get_peer(self, hostport):
        return self.add_peer(hostport)

    def request(self, hostport, service=None):
        return TChannelClientOperation(hostport, service, self)

    def host(self, port, handler):
        return TChannelServerOperation(port, handler)


class TChannelServerOperation(object):

    def __init__(self, port, handler):
        self.inbound_server = TChannelServer(handler)
        self.port = port

    def listen(self):
        self.inbound_server.listen(self.port)


class TChannelClientOperation(object):

    def __init__(self, hostport, service, tchannel):
        self.hostport = hostport
        self.message_id = None
        self.service = service or ''
        self.tchannel = weakref.ref(tchannel)

    @tornado.gen.coroutine
    def send(self, arg_1, arg_2, arg_3):
        # message = CallRequestMessage.from_context for zipkin shit
        # Make this return a message ID so we can match it up with the
        # response.
        peer_connection = yield self.tchannel().get_peer(self.hostport)
        self.message_id = message_id = peer_connection.next_message_id()

        def safebytes(arg):
            if arg is None:
                return None
            if isinstance(arg, bytes):
                return arg
            return bytes(arg.encode('ascii'))

        message = CallRequestMessage(
            service=self.service,
            args=[safebytes(arg_1),
                  arg_3,
                  arg_3],
        )

        log.debug("framing and writing message %s", message_id)

        # TODO: return response future here?
        yield peer_connection.frame_and_write_stream(
            message,
            message_id=message_id,
        )

        log.debug("awaiting response for message %s", message_id)

        # Pull this out into its own loop, look up response message ids
        # and dispatch them to handlers.
        response_future = tornado.gen.Future()
        peer_connection.awaiting_responses[message_id] = response_future
        with timeout(response_future):
            response = yield response_future

        log.debug("got response for message %s", response.message_id)

        if not response:
            raise InvalidMessageException()

        raise tornado.gen.Return(response.message)