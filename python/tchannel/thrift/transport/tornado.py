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

from thrift import Thrift
from thrift.protocol import TBinaryProtocol
from thrift.transport import TTransport

from tornado import gen
from tornado import ioloop
try:
    from tornado.queues import Queue  # Included in Tornado 4.2
except ImportError:
    from toro import Queue

from tchannel.io import BytesIO
from .base import TChannelTransportBase


class TChannelTornadoTransport(TChannelTransportBase):
    """A Thrift Transport to send requests over an open TChannel connection.

    Works with Thrift clients generated with the ``tornado`` option enabled.

    .. code-block::

        transport = TChannelTornadoTransport(
            tchannel, host_port, 'foo_service'
        )
        transport.init_call('FooService::doBar')
        transport.write('request body')
        transport.flush()

        response_body = yield transport.readFrame()

    VERY IMPORTANT IMPLEMENTATION DETAIL: For Tornado responses, Thrift calls
    ``readFrame`` which produces the serialized payload. It then constructs a
    ``TMemoryBuffer`` and gets all the response details out of that. So we
    have no way of communicating response details from the
    ``CallResponseMessage`` to the ``TChannelProtocol``. To work around that,
    there's a janky hack in place: When we receive a response, we prepend the
    missing information (endpoint name, message type, and seqid) to the
    payload. ``TChannelProtocolFramed`` knows how to read this.
    ``TChannelProtocolFactory`` automatically uses a
    ``TChannelProtocolFramed`` if the transport being used is not a
    ``TChannelTransportBase``.
    """

    def __init__(self, tchannel, hostport, service_name, io_loop=None):
        super(TChannelTornadoTransport, self).__init__(
            tchannel, hostport, service_name
        )

        self._response_queue = Queue()
        self.io_loop = io_loop or ioloop.IOLoop.current()

    def readFrame(self):
        return self._response_queue.get()

    def read(self, n):
        raise NotImplementedError(
            "read() must not be called directly. Use readFrame()."
        )

    def recv_call(self):
        raise NotImplementedError(
            "recv_call() not supported for Tornado. Use readFrame()."
        )

    @gen.coroutine
    def flush(self):
        payload = self._wbuf.getvalue()
        self._wbuf = BytesIO()  # avoid buffer leaking between requests

        endpoint, seqid = self._endpoint, self._seqid
        response = yield self._tchannel.request(
            self._hostport, self._service_name
        ).send(
            endpoint,
            '',  # TODO: headers
            payload,
        )

        buff = TTransport.TMemoryBuffer()

        # This is so dirty, /I can't even.../
        TBinaryProtocol.TBinaryProtocol(buff).writeMessageBegin(
            endpoint,
            Thrift.TMessageType.REPLY,  # TODO exceptions
            seqid,
        )

        buff.write(response.args[2])
        self._response_queue.put(buff.getvalue())
