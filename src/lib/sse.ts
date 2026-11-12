export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trimStart();
        if (data && data !== "[DONE]") yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    const data = tail.slice(5).trimStart();
    if (data && data !== "[DONE]") yield data;
  }
}

const encoder = new TextEncoder();

export function encodeSSE(event: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export function sseResponse<T>(events: AsyncIterable<T>, onCancel?: () => void): Response {
  const iterator = events[Symbol.asyncIterator]();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(encodeSSE(value));
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      onCancel?.();
      await iterator.return?.();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
