import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { streamFetch } from "../../src/backend/pinned.js";

let server: http.Server | null = null;
let release: (() => void) | null = null;

afterEach(async () => {
  release?.();
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  server = null;
});

async function startStream(): Promise<number> {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "multipart/x-mixed-replace" });
    res.write("first frame");
    // Never ends until the test is done, like a video stream.
    release = () => res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server!.address() as AddressInfo).port;
}

describe("streamFetch", () => {
  it("hands over the body before the stream ends", async () => {
    const port = await startStream();
    const response = await streamFetch(`http://127.0.0.1:${port}/stream`, {
      allowPrivateHosts: ["127.0.0.1"],
      timeoutMs: 5000,
    });
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(Buffer.from(value!).toString()).toBe("first frame");
    await reader.cancel();
  });

  it("refuses a private address that is not the saved device", async () => {
    const port = await startStream();
    await expect(
      streamFetch(`http://127.0.0.1:${port}/stream`, {
        allowPrivateHosts: ["10.0.0.9"],
      }),
    ).rejects.toThrow();
  });

  it("refuses other protocols", async () => {
    await expect(
      streamFetch("file:///etc/passwd", { allowPrivateHosts: [] }),
    ).rejects.toThrow("Only http and https");
  });
});
