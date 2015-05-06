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

from tchannel.event import EventHook
from tchannel.zipkin import annotation
from tchannel.zipkin.tracers import DebugTracer
from tchannel.zipkin.tracers import TChannelZipkinTracer


class ZipkinTraceHook(EventHook):
    """generate zipkin-style span for tracing"""

    def __init__(self, tchannel=None, dst=None):
        if tchannel:
            # TChannelZipkinTracer generates Base64-encoded span
            # and uploads to zipkin server
            self.tracer = TChannelZipkinTracer(tchannel)
        else:
            # DebugTracer generates json style span info and writes
            # to dst. By default it writes to stdout
            self.tracer = DebugTracer(dst)

    def send_request(self, context):
        if not context.tracing.traceflags:
            return

        ann = annotation.client_send()
        context.tracing.annotations.append(ann)

    def receive_request(self, context):
        if not context.tracing.traceflags:
            return

        ann = annotation.server_recv()
        context.tracing.annotations.append(ann)

    def send_response(self, context):
        if not context.tracing.traceflags:
            return

        # send out a pair of annotations{server_recv, server_send} to zipkin
        ann = annotation.server_send()
        context.tracing.annotations.append(ann)
        self.tracer.record([(context.tracing, context.tracing.annotations)])

    def receive_response(self, context):
        if not context.tracing.traceflags:
            return

        # send out a pair of annotations{client_recv, client_send} to zipkin
        ann = annotation.client_recv()
        context.tracing.annotations.append(ann)
        self.tracer.record([(context.tracing, context.tracing.annotations)])
