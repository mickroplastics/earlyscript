// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - a local HTTP mirror of the model files for tests.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { QWEN_MODEL, QWEN_REVISION } from "../embed/spec.ts";
import type { ModelFile } from "../embed/model.ts";

export interface MirrorRequest {
  readonly file: string;
  readonly range: string | null;
}

export interface ModelMirror {
  readonly baseUrl: string;
  readonly requests: Array<MirrorRequest>;
  /** The next response of `file` sends this many bytes and then drops the connection. */
  cutNext(file: string, afterBytes: number): void;
  close(): Promise<void>;
}

/** Small files with their real hashes and sizes, for `prepareModel({ files })`. */
export function syntheticModelFiles(
  contents: Record<string, Buffer>,
): Array<ModelFile & { body: Buffer }> {
  return Object.entries(contents).map(([file, body]) => ({
    file,
    body,
    bytes: body.length,
    sha256: NodeCrypto.createHash("sha256").update(body).digest("hex"),
  }));
}

/**
 * Serves `<model>/resolve/<revision>/<file>` like Hugging Face, from memory or from a model
 * directory, honouring `Range: bytes=<from>-` with a 206.
 */
export async function serveModel(
  source: { readonly files: Record<string, Buffer> } | { readonly dir: string },
): Promise<ModelMirror> {
  const prefix = `/${QWEN_MODEL}/resolve/${QWEN_REVISION}/`;
  const requests: Array<MirrorRequest> = [];
  const cuts = new Map<string, number>();
  const sockets = new Set<NodeHttp.IncomingMessage["socket"]>();
  const sizeOf = (file: string): number | null => {
    if ("files" in source) return source.files[file]?.length ?? null;
    const stat = NodeFS.statSync(NodePath.join(source.dir, file), { throwIfNoEntry: false });
    return stat?.size ?? null;
  };
  const server = NodeHttp.createServer((request, response) => {
    const url = request.url ?? "";
    const file = url.startsWith(prefix) ? decodeURIComponent(url.slice(prefix.length)) : "";
    const range = request.headers.range ?? null;
    requests.push({ file, range });
    const size = file === "" ? null : sizeOf(file);
    if (size === null) {
      response.statusCode = 404;
      response.end();
      return;
    }
    const from = Number(/^bytes=(\d+)-$/.exec(range ?? "")?.[1] ?? 0);
    const cut = cuts.get(file);
    cuts.delete(file);
    const end = cut === undefined ? size : Math.min(size, from + cut);
    response.writeHead(range === null ? 200 : 206, {
      "content-length": String(size - from),
      ...(range === null ? {} : { "content-range": `bytes ${from}-${size - 1}/${size}` }),
    });
    const body =
      "files" in source
        ? NodeStream.Readable.from([source.files[file]!.subarray(from, end)])
        : NodeFS.createReadStream(NodePath.join(source.dir, file), {
            start: from,
            end: Math.max(from, end - 1),
          });
    body.pipe(response, { end: cut === undefined });
    // Drops the connection once the sent bytes have left, as a network failure would.
    if (cut !== undefined) {
      body.on("end", () =>
        response.write("", () => setTimeout(() => request.socket.destroy(), 50)),
      );
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    cutNext: (file, afterBytes) => cuts.set(file, afterBytes),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
