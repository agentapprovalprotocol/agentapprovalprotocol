/** Mount a receiver on a Node `http` server, or Express and other frameworks built on it. */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Receiver } from "./receiver.js";

/** A Node `http` request listener that accepts POSTed webhooks. */
export function nodeListener(receiver: Receiver): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Uint8Array[] = [];
    req.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    req.on("error", () => res.writeHead(400).end());
    req.on("end", () => {
      const body = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      receiver.handle(req.headers, body).then(
        (reply) => {
          res.writeHead(reply.status, reply.body ? { "content-type": "application/json" } : {}).end(reply.body);
        },
        () => res.writeHead(500).end(),
      );
    });
  };
}
