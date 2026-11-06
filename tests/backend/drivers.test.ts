import { describe, expect, it, vi } from "vitest";
import { createKeyboard } from "../../src/shared/hid.js";
import { createMjpegParser } from "../../src/backend/drivers/mjpeg.js";
import { glkvm, pikvm } from "../../src/backend/drivers/pikvm.js";
import { normalizePin, PIN } from "../../src/backend/pinned.js";
import { encryptPassword, nanokvm } from "../../src/backend/drivers/nanokvm.js";
import { jetkvm, relaySession } from "../../src/backend/drivers/jetkvm.js";
import type {
  DeviceSocket,
  DriverIo,
  Target,
} from "../../src/backend/drivers/index.js";
import { parseInput } from "../../src/backend/screen.js";
import { magicPacket } from "../../src/backend/service.js";
import { fakeFetch, json, status } from "./fake-fetch.js";

const JPEG_A = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from("aaaa"),
  Buffer.from([0xff, 0xd9]),
]);
const JPEG_B = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from("bb"),
  Buffer.from([0xff, 0xd9]),
]);

function part(jpeg: Buffer, withLength: boolean) {
  const header = `--frame\r\nContent-Type: image/jpeg\r\n${
    withLength ? `Content-Length: ${jpeg.length}\r\n` : ""
  }\r\n`;
  return Buffer.concat([Buffer.from(header), jpeg, Buffer.from("\r\n")]);
}

function target(extra: Partial<Target> = {}): Target {
  return {
    address: "10.0.0.60",
    port: 443,
    options: {},
    credentials: { username: "admin", password: "secret" },
    ...extra,
  };
}

class FakeSocket implements DeviceSocket {
  sent: Array<string | Buffer> = [];
  closed = false;
  listeners = new Map<string, Array<(...args: never[]) => void>>();
  send(data: string | Buffer) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  on(event: string, listener: (...args: never[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string) {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

function streamResponse(chunks: Buffer[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "multipart/x-mixed-replace; boundary=frame" },
  });
}

describe("mjpeg parser", () => {
  it("reads frames that have a length, even in odd chunks", () => {
    const frames: Buffer[] = [];
    const parser = createMjpegParser((frame) =>
      frames.push(Buffer.from(frame)),
    );
    const all = Buffer.concat([part(JPEG_A, true), part(JPEG_B, true)]);
    for (let i = 0; i < all.length; i += 7) parser.push(all.subarray(i, i + 7));
    expect(frames).toEqual([JPEG_A, JPEG_B]);
  });

  it("falls back to the JPEG markers without a length", () => {
    const frames: Buffer[] = [];
    const parser = createMjpegParser((frame) =>
      frames.push(Buffer.from(frame)),
    );
    parser.push(Buffer.concat([part(JPEG_A, false), part(JPEG_B, false)]));
    expect(frames).toEqual([JPEG_A, JPEG_B]);
  });
});

describe("keyboard", () => {
  it("builds boot reports with modifiers and held keys", () => {
    const keyboard = createKeyboard();
    expect(keyboard.press("ControlLeft", true)).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(keyboard.press("KeyA", true)).toEqual([1, 0, 4, 0, 0, 0, 0, 0]);
    expect(keyboard.press("KeyA", false)).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(keyboard.press("Unknown", true)).toBeNull();
    expect(keyboard.release()).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("input parsing", () => {
  it("accepts good events and drops the rest", () => {
    expect(parseInput({ t: "key", code: "KeyA", down: true })).toEqual({
      t: "key",
      code: "KeyA",
      down: true,
    });
    expect(parseInput({ t: "button", button: 3, down: true })).toBeNull();
    expect(
      parseInput({ t: "key", code: "x".repeat(40), down: true }),
    ).toBeNull();
    expect(parseInput({ t: "text", text: "a".repeat(10_001) })).toBeNull();
    expect(parseInput(null)).toBeNull();
  });
});

describe("wake on lan", () => {
  it("builds a magic packet", () => {
    const packet = magicPacket("aa:bb:cc:dd:ee:ff");
    expect(packet.length).toBe(102);
    expect(packet.subarray(0, 6).every((byte) => byte === 0xff)).toBe(true);
    expect(packet.subarray(96).toString("hex")).toBe("aabbccddeeff");
  });
});

describe("pikvm", () => {
  const atx = { result: { leds: { power: true } } };
  const fetch = fakeFetch((url, init) => {
    if (url.hostname !== "10.0.0.60") return undefined;
    expect(init.headers?.["x-kvmd-user"]).toBe("admin");
    switch (url.pathname) {
      case "/api/info":
        return json({
          result: {
            system: { kvmd: { version: "4.1" } },
            hw: { platform: { model: "v3 hdmi" } },
            meta: { server: { host: "pikvm" } },
          },
        });
      case "/api/atx":
        return json(atx);
      case "/api/streamer":
        return json({
          result: {
            streamer: {
              source: {
                online: true,
                resolution: { width: 1920, height: 1080 },
              },
            },
          },
        });
      case "/api/atx/power":
      case "/api/msd/set_connected":
      case "/api/msd/set_params":
      case "/api/hid/print":
        return json({ result: {} });
      case "/api/msd":
        return json({
          result: {
            enabled: true,
            storage: { images: { "debian.iso": { size: 5 } } },
            drive: {
              image: { name: "debian.iso" },
              connected: true,
              cdrom: true,
            },
          },
        });
      case "/streamer/stream":
        return streamResponse([part(JPEG_A, true), part(JPEG_B, true)]);
      default:
        return status(404);
    }
  });
  const sockets: FakeSocket[] = [];
  const io: DriverIo = {
    fetch: fetch as never,
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  };

  it("reads the KVM", async () => {
    const reading = await pikvm.read(target(), io);
    expect(reading).toMatchObject({
      model: "v3 hdmi",
      version: "4.1",
      hostname: "pikvm",
      power: "on",
      width: 1920,
      signal: true,
    });
  });

  it("refuses a bad login", async () => {
    const refusing: DriverIo = {
      ...io,
      fetch: fakeFetch(() => status(401)) as never,
    };
    await expect(pikvm.read(target(), refusing)).rejects.toThrow(/refused/);
  });

  it("maps power actions to ATX actions", async () => {
    fetch.calls.length = 0;
    await pikvm.power!(target(), io, "off");
    await pikvm.power!(target(), io, "graceful-shutdown");
    await pikvm.power!(target(), io, "reset");
    const urls = fetch.calls.map((call) => call.url);
    expect(urls[0]).toContain("action=off_hard");
    expect(urls[1]).toContain("action=off&");
    expect(urls[2]).toContain("action=reset_hard");
  });

  it("lists and mounts images", async () => {
    const media = await pikvm.media!.list(target(), io);
    expect(media).toMatchObject({
      mounted: "debian.iso",
      cdrom: true,
      images: [{ id: "debian.iso" }],
    });
    fetch.calls.length = 0;
    await pikvm.media!.mount(target(), io, "debian.iso", true);
    expect(fetch.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/msd/set_connected",
      "/api/msd/set_params",
      "/api/msd/set_connected",
    ]);
  });

  it("streams frames and sends input", async () => {
    sockets.length = 0;
    const frames: Buffer[] = [];
    const session = await pikvm.screen!(target(), io, {
      onFrame: (frame) => frames.push(Buffer.from(frame)),
      onClose: () => {},
    });
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    const socket = sockets[0];
    // Sent before the socket opens, so it waits
    session.input({ t: "key", code: "KeyA", down: true });
    expect(socket.sent).toHaveLength(0);
    socket.emit("open");
    session.input({ t: "button", button: 0, down: true });
    session.input({ t: "move", x: 0, y: 1 });
    const sent = socket.sent.map((item) => JSON.parse(String(item)));
    expect(sent[0]).toEqual({
      event_type: "key",
      event: { key: "KeyA", state: true },
    });
    expect(sent[1].event).toEqual({ button: "left", state: true });
    expect(sent[2].event.to).toEqual({ x: -32768, y: 32767 });
    session.close();
    expect(socket.closed).toBe(true);
  });

  it("takes a snapshot from the first frame", async () => {
    expect(Buffer.from(await pikvm.snapshot!(target(), io))).toEqual(JPEG_A);
  });
});

describe("nanokvm", () => {
  it("encrypts the password in CryptoJS format", () => {
    const salt = Buffer.from("0102030405060708", "hex");
    const out = decodeURIComponent(encryptPassword("admin", salt));
    const raw = Buffer.from(out, "base64");
    expect(raw.subarray(0, 8).toString()).toBe("Salted__");
    expect(raw.subarray(8, 16)).toEqual(salt);
    expect(raw.length).toBe(32);
  });

  it("logs in once, reuses the token and reads the KVM", async () => {
    let logins = 0;
    const fetch = fakeFetch((url, init) => {
      switch (url.pathname) {
        case "/api/auth/login":
          logins++;
          return json({ code: 0, msg: "success", data: { token: "tok" } });
        case "/api/vm/info":
          expect(init.headers?.cookie).toBe("nano-kvm-token=tok");
          return json({ code: 0, data: { application: "2.0", mdns: "nano" } });
        case "/api/vm/gpio":
          return init.method === "POST"
            ? json({ code: 0, data: {} })
            : json({ code: 0, data: { pwr: false } });
        default:
          return status(404);
      }
    });
    const io: DriverIo = {
      fetch: fetch as never,
      connect: () => new FakeSocket(),
    };
    const nano = target({ address: "10.0.0.61", port: 80 });
    const reading = await nanokvm.read(nano, io);
    expect(reading).toMatchObject({
      model: "NanoKVM",
      power: "off",
      hostname: "nano",
    });
    await nanokvm.read(nano, io);
    expect(logins).toBe(1);
    await nanokvm.power!(nano, io, "off");
    const post = fetch.calls.find(
      (call) => call.init.method === "POST" && call.url.endsWith("/gpio"),
    );
    expect(JSON.parse(post!.init.body)).toEqual({
      type: "power",
      duration: 8000,
    });
  });

  it("says when the login is refused", async () => {
    const io: DriverIo = {
      fetch: fakeFetch(() => json({ code: -2, msg: "bad" })) as never,
      connect: () => new FakeSocket(),
    };
    await expect(
      nanokvm.read(target({ address: "10.0.0.62", port: 80 }), io),
    ).rejects.toThrow(/refused/);
  });
});

describe("jetkvm", () => {
  it("reads the status and relays an offer with the login cookie", async () => {
    const fetch = fakeFetch((url, init) => {
      switch (url.pathname) {
        case "/device/status":
          return json({ isSetup: true });
        case "/auth/login-local":
          return json({}, { "set-cookie": "authToken=abc; Path=/; HttpOnly" });
        case "/webrtc/session":
          expect(init.headers?.cookie).toBe("authToken=abc");
          expect(JSON.parse(init.body)).toEqual({ sd: "OFFER" });
          return json({ sd: "ANSWER" });
        default:
          return status(404);
      }
    });
    const io: DriverIo = {
      fetch: fetch as never,
      connect: () => new FakeSocket(),
    };
    const jet = target({
      address: "10.0.0.63",
      port: 80,
      credentials: { password: "pw" },
    });
    expect((await jetkvm.read(jet, io)).model).toBe("JetKVM");
    expect(await relaySession(jet, io, "OFFER")).toBe("ANSWER");
  });

  it("reports a JetKVM that is not set up", async () => {
    const io: DriverIo = {
      fetch: fakeFetch(() => json({ isSetup: false })) as never,
      connect: () => new FakeSocket(),
    };
    await expect(
      jetkvm.read(
        target({ address: "10.0.0.64", port: 80, credentials: {} }),
        io,
      ),
    ).rejects.toThrow(/not been set up/);
  });
});

describe("glkvm", () => {
  const pin = Array.from({ length: 32 }, () => "AB").join(":");

  it("asks only for the password and logs in as admin", async () => {
    expect(glkvm.info.fields.map((field) => field.key)).toEqual(["password"]);
    const seen: Array<Record<string, string> | undefined> = [];
    const io: DriverIo = {
      fetch: fakeFetch((url, init) => {
        seen.push(init.headers);
        return url.pathname === "/api/info"
          ? json({ result: { hw: { platform: { model: "rm1" } } } })
          : json({ result: {} });
      }) as never,
      connect: () => new FakeSocket(),
    };
    const reading = await glkvm.read(
      target({ credentials: { password: "secret" } }),
      io,
    );
    expect(reading.model).toBe("rm1");
    expect(seen[0]?.["x-kvmd-user"]).toBe("admin");
    expect(seen[0]?.["x-kvmd-passwd"]).toBe("secret");
  });

  it("goes through the pinned fetch when a certificate is pinned", async () => {
    const fetch = vi.fn();
    const fetchPinned = vi.fn(async (url: string, _pin: string) =>
      new URL(url).pathname === "/api/info"
        ? Response.json({ result: { hw: { platform: { model: "rm1" } } } })
        : Response.json({ result: {} }),
    );
    await glkvm.read(target({ options: { pin } }), {
      fetch: fetch as never,
      fetchPinned,
      connect: () => new FakeSocket(),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(fetchPinned.mock.calls[0][1]).toBe(pin);
  });

  it("reports power as unknown without an ATX board", async () => {
    const reading = await glkvm.read(
      target({ credentials: { password: "x" } }),
      {
        fetch: fakeFetch((url) =>
          url.pathname === "/api/atx"
            ? json({ result: { enabled: false, leds: { power: false } } })
            : json({ result: {} }),
        ) as never,
        connect: () => new FakeSocket(),
      },
    );
    expect(reading.power).toBe("unknown");
  });

  it("takes a snapshot once the streamer starts", async () => {
    let calls = 0;
    const sockets: FakeSocket[] = [];
    const jpeg = await glkvm.snapshot!(
      target({ credentials: { password: "x" } }),
      {
        fetch: fakeFetch((url) => {
          if (url.pathname !== "/streamer/snapshot") return status(404);
          calls += 1;
          return calls === 1
            ? status(502)
            : new Response(new Uint8Array(JPEG_A), { status: 200 });
        }) as never,
        connect: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      },
    );
    expect(Buffer.compare(jpeg, JPEG_A)).toBe(0);
    expect(calls).toBe(2);
    expect(sockets[0].closed).toBe(true);
  });

  it("checks pins", () => {
    expect(PIN.test(normalizePin(pin.toLowerCase()))).toBe(true);
    expect(PIN.test("AB:CD")).toBe(false);
  });
});
