import type { Context } from 'aws-lambda';
import type { Writable } from 'node:stream';

declare global {
  namespace awslambda {
    type ResponseStream = Writable;

    function streamifyResponse<TEvent = unknown>(
      handler: (event: TEvent, responseStream: ResponseStream, context: Context) => Promise<void>,
    ): (event: TEvent, responseStream: ResponseStream, context: Context) => Promise<void>;

    namespace HttpResponseStream {
      function from(
        responseStream: ResponseStream,
        metadata: { statusCode: number; headers?: Record<string, string> },
      ): ResponseStream;
    }
  }
}
