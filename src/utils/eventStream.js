// A server-sent event stream (chat replies, deck/document writing, document upload). Every stream ends with a
// { phase: 'done' } or { phase: 'error' } event; in between, a keep-alive comment every few seconds tells the
// client the server is still working, so the client can treat a silent stream as lost (a server restart once
// left a chat on "Rewriting..." for ten minutes) without cutting off a long, quiet step.
const KEEPALIVE_MS = 5000;

export function openEventStream(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  let open = true;
  const keepalive = setInterval(() => { if (open) res.write(': keepalive\n\n'); }, KEEPALIVE_MS);
  // The response's close, not the request's: a request whose body was already read can report closed early.
  res.on('close', () => { open = false; clearInterval(keepalive); });
  return {
    send: (data) => { if (open) res.write(`data: ${JSON.stringify(data)}\n\n`); },
    isOpen: () => open,
    end: () => { clearInterval(keepalive); if (open) res.end(); },
  };
}
