import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Router } from "express";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";
import { fakeFetch, json, status } from "./fake-fetch.js";

const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;

let refuse = false;
let powered = true;
const powerCalls: string[] = [];
const jpeg = Buffer.from([0xff, 0xd8, 0x61, 0xff, 0xd9]);

const router = fakeFetch((url, init) => {
  if (url.hostname !== "10.0.0.9") return undefined;
  if (refuse) return status(401);
  switch (url.pathname) {
    case "/api/info":
      return json({ result: { system: { kvmd: { version: "4.1" } } } });
    case "/api/atx":
      return json({ result: { leds: { power: powered } } });
    case "/api/streamer":
      return json({ result: { streamer: { source: { online: true } } } });
    case "/api/atx/power":
      powerCalls.push(url.searchParams.get("action") ?? "");
      return json({ result: {} });
    case "/api/hid/print":
      powerCalls.push(`print:${init.body}`);
      return json({ result: {} });
    case "/api/msd":
      return json({
        result: {
          enabled: true,
          storage: { images: { "a.iso": { size: 1 } } },
          drive: { image: null, connected: false, cdrom: true },
        },
      });
    case "/api/msd/set_params":
    case "/api/msd/set_connected":
      return json({ result: {} });
    case "/streamer/stream":
      return new Response(
        Buffer.concat([
          Buffer.from("--f\r\nContent-Length: 5\r\n\r\n"),
          jpeg,
          Buffer.from("\r\n"),
        ]),
        { status: 200 },
      );
    default:
      return status(404);
  }
});

let db: TestDb;
let mock: MockPluginContext;
let server: http.Server;
let port: number;
let access = true;

async function setup(permissions: string[]) {
  db = await createTestDb(pluginDir);
  for (const user of ["user-1", "user-2"]) {
    db.sqlite
      .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
      .run(user, user);
  }
  let routes: Router | null = null;
  mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    db: db.database,
    router: () => (routes = express.Router()),
    permissions,
    fetch: router as never,
  });
  (mock.ctx.hosts as { checkAccess: unknown }).checkAccess = async () => ({
    hasAccess: access,
  });
  await activate(mock.ctx);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    mock.setActor(req.header("x-test-user") ?? "user-1");
    next();
  });
  app.use((req, res, next) => routes!(req, res, next));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
}

async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    type,
    body: type.includes("json")
      ? await response.json()
      : Buffer.from(await response.arrayBuffer()),
  };
}

const ALL = [
  "ip-kvm.view",
  "ip-kvm.power",
  "ip-kvm.console",
  "ip-kvm.media",
  "ip-kvm.manage",
];

const input = {
  name: "rack-kvm",
  driver: "pikvm",
  address: "10.0.0.9",
  options: { scheme: "https", mac: "AA-BB-CC-DD-EE-FF" },
  credentials: { username: "admin", password: "SECRET-PASSWORD" },
};

async function addDevice(extra: Record<string, unknown> = {}) {
  const created = await request("POST", "/devices", { ...input, ...extra });
  expect(created.status).toBe(201);
  return (created.body as any).device.id as number;
}

beforeEach(async () => {
  refuse = false;
  powered = true;
  access = true;
  powerCalls.length = 0;
  router.mockClear();
  router.calls.length = 0;
  await setup(ALL);
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe("devices", () => {
  it("lists the KVM types", async () => {
    const result = await request("GET", "/drivers");
    expect(
      (result.body as any).drivers.map((d: { id: string }) => d.id).sort(),
    ).toEqual(["glkvm", "jetkvm", "nanokvm", "pikvm"]);
  });

  it("adds a KVM and never shows or stores the login in plain text", async () => {
    await addDevice();
    const list = (await request("GET", "/devices")).body as any;
    expect(list.devices).toHaveLength(1);
    expect(list.devices[0].options.mac).toBe("aa:bb:cc:dd:ee:ff");
    expect(JSON.stringify(list)).not.toContain("SECRET-PASSWORD");
    const stored = db.sqlite
      .prepare("SELECT credentials FROM p_ip_kvm_devices")
      .get() as { credentials: string };
    expect(stored.credentials).not.toContain("SECRET-PASSWORD");
  });

  it("reads power and video", async () => {
    const id = await addDevice();
    const polled = (await request("POST", `/devices/${id}/poll`)).body as any;
    expect(polled.device.status).toBe("up");
    expect(polled.device.reading).toMatchObject({ power: "on", signal: true });
  });

  it("marks a KVM down after two failed readings and says why", async () => {
    const id = await addDevice();
    await request("POST", `/devices/${id}/poll`);
    refuse = true;
    const first = (await request("POST", `/devices/${id}/poll`)).body as any;
    expect(first.device.status).toBe("up");
    const second = (await request("POST", `/devices/${id}/poll`)).body as any;
    expect(second.device.status).toBe("down");
    expect(second.device.lastError).toMatch(/refused the login/);
    expect(JSON.stringify(mock.notifications)).toContain("ip-kvm.down");
  });

  it("alerts when the machine changes power on its own, but not after our change", async () => {
    const id = await addDevice();
    await request("POST", `/devices/${id}/poll`);
    powered = false;
    await request("POST", `/devices/${id}/poll`);
    expect(JSON.stringify(mock.notifications)).toContain("ip-kvm.power");

    const before = JSON.stringify(mock.notifications).length;
    await request("POST", `/devices/${id}/power`, { action: "on" });
    powered = true;
    await request("POST", `/devices/${id}/poll`);
    expect(JSON.stringify(mock.notifications).length).toBe(before);
  });

  it("rejects bad input", async () => {
    const bad = async (extra: Record<string, unknown>) =>
      (await request("POST", "/devices", { ...input, ...extra })).status;
    expect(await bad({ name: " " })).toBe(400);
    expect(await bad({ address: "a b" })).toBe(400);
    expect(await bad({ driver: "nope" })).toBe(400);
    expect(await bad({ credentials: {} })).toBe(400);
    expect(await bad({ ca: "not a cert" })).toBe(400);
    expect(await bad({ port: 99999 })).toBe(400);
    expect(await bad({ options: { mac: "zz" } })).toBe(400);
    expect(await bad({ options: { broadcast: "x" } })).toBe(400);
  });

  it("keeps the poll interval above the floor", async () => {
    await addDevice({ pollSeconds: 1 });
    const list = (await request("GET", "/devices")).body as any;
    expect(list.devices[0].pollSeconds).toBe(30);
  });

  it("refuses a second KVM with the same name", async () => {
    await addDevice();
    expect((await request("POST", "/devices", input)).status).toBe(409);
  });

  it("keeps the saved login when an edit sends none", async () => {
    const id = await addDevice();
    const before = db.sqlite
      .prepare("SELECT credentials FROM p_ip_kvm_devices")
      .get() as { credentials: string };
    const changed = await request("PUT", `/devices/${id}`, {
      name: "rack-kvm-b",
      address: "10.0.0.9",
    });
    expect(changed.status).toBe(200);
    const after = db.sqlite
      .prepare("SELECT credentials FROM p_ip_kvm_devices")
      .get() as { credentials: string };
    expect(after.credentials).toBe(before.credentials);
  });

  it("deletes a KVM", async () => {
    const id = await addDevice();
    expect((await request("DELETE", `/devices/${id}`)).status).toBe(200);
    expect(((await request("GET", "/devices")).body as any).devices).toEqual(
      [],
    );
  });

  it("tests a login without saving", async () => {
    const tested = await request("POST", "/devices/test", input);
    expect(tested.status).toBe(200);
    expect(((await request("GET", "/devices")).body as any).devices).toEqual(
      [],
    );
    refuse = true;
    expect((await request("POST", "/devices/test", input)).status).toBe(502);
  });
});

describe("actions", () => {
  it("sends power actions and rejects unknown ones", async () => {
    const id = await addDevice();
    expect(
      (await request("POST", `/devices/${id}/power`, { action: "off" })).status,
    ).toBe(200);
    expect(powerCalls).toEqual(["off_hard"]);
    expect(
      (await request("POST", `/devices/${id}/power`, { action: "explode" }))
        .status,
    ).toBe(400);
  });

  it("types pasted text and returns a snapshot", async () => {
    const id = await addDevice();
    expect(
      (await request("POST", `/devices/${id}/paste`, { text: "ls -la" }))
        .status,
    ).toBe(200);
    expect(powerCalls).toEqual(["print:ls -la"]);
    expect(
      (await request("POST", `/devices/${id}/paste`, { text: "" })).status,
    ).toBe(400);
    const shot = await request("GET", `/devices/${id}/snapshot`);
    expect(shot.type).toContain("image/jpeg");
    expect(Buffer.from(shot.body as Buffer)).toEqual(jpeg);
  });

  it("lists and mounts images, and checks the download address", async () => {
    const id = await addDevice();
    const list = (await request("GET", `/devices/${id}/media`)).body as any;
    expect(list.media.images[0].id).toBe("a.iso");
    expect(
      (await request("POST", `/devices/${id}/media/mount`, { image: "a.iso" }))
        .status,
    ).toBe(200);
    expect((await request("POST", `/devices/${id}/media/eject`)).status).toBe(
      200,
    );
    expect(
      (
        await request("POST", `/devices/${id}/media/fetch`, {
          url: "ftp://x/y.iso",
          name: "y.iso",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("POST", `/devices/${id}/media/fetch`, {
          url: "https://x/y.iso",
          name: "../y",
        })
      ).status,
    ).toBe(400);
  });

  it("refuses a JetKVM session for another type", async () => {
    const id = await addDevice();
    expect(
      (await request("POST", `/devices/${id}/session`, { sd: "x" })).status,
    ).toBe(400);
  });

  it("refuses wake without a MAC", async () => {
    const id = await addDevice({ options: { scheme: "https" } });
    expect((await request("POST", `/devices/${id}/wake`)).status).toBe(400);
  });
});

describe("host links", () => {
  it("hides a KVM when the linked host is not allowed", async () => {
    const id = await addDevice({ hostId: 5 });
    access = false;
    expect(((await request("GET", "/devices")).body as any).devices).toEqual(
      [],
    );
    expect((await request("POST", `/devices/${id}/poll`)).status).toBe(404);
    expect(
      (await request("POST", `/devices/${id}/power`, { action: "on" })).status,
    ).toBe(403);
  });

  it("clears the link when the host is deleted", async () => {
    await addDevice({ hostId: 5 });
    mock.ctx.events.emit("host.deleted", { hostId: 5 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const row = db.sqlite
      .prepare("SELECT host_id FROM p_ip_kvm_devices")
      .get() as { host_id: number | null };
    expect(row.host_id).toBeNull();
  });
});

describe("permissions", () => {
  it("lets a viewer look but not change anything", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    await setup(["ip-kvm.view"]);
    expect((await request("GET", "/devices")).status).toBe(200);
    expect((await request("POST", "/devices", input)).status).toBe(403);
  });
});
