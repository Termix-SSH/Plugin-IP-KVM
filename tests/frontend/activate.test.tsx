import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";
import { statusTone } from "../../src/frontend/format";
import { pointerPosition, shortcutEvents } from "../../src/frontend/input";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

const device = {
  id: 1,
  hostId: null,
  name: "rack-kvm",
  driver: "pikvm",
  address: "10.0.0.9",
  port: null,
  options: {},
  hasCa: false,
  pollSeconds: 60,
  status: "up",
  lastError: null,
  lastSeenAt: null,
  reading: { at: "", power: "on" },
};

function api(devices: unknown[]) {
  return {
    get: vi.fn(async (path: string) => ({
      data: path === "/drivers" ? { drivers: [] } : { devices },
    })),
  } as never;
}

describe(`${manifest.id} activate`, () => {
  it("registers the rail item, tab and dashboard card", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toEqual(["ip-kvm"]);
    expect(rendered.registered.railItems()).toEqual([
      expect.objectContaining({ id: "ip-kvm", permission: "ip-kvm.view" }),
    ]);
  });

  it("lists KVMs with their power", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api([device]),
    });
    rendered.renderTab("ip-kvm", { isVisible: true });
    expect(await screen.findByText("rack-kvm")).toBeTruthy();
    expect(screen.getByText(/10\.0\.0\.9 \| On/)).toBeTruthy();
  });

  it("shows the empty state", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api([]),
    });
    rendered.renderTab("ip-kvm", { isVisible: true });
    expect(await screen.findByText(locales.empty)).toBeTruthy();
  });
});

describe("helpers", () => {
  it("picks tones", () => {
    expect(statusTone("down", "on")).toBe("bad");
    expect(statusTone("up", "off")).toBe("warn");
    expect(statusTone("up", "on")).toBe("ok");
    expect(statusTone("unknown", undefined)).toBe("idle");
  });

  it("maps a pointer to 0 to 1 and clamps it", () => {
    const element = {
      getBoundingClientRect: () => ({
        left: 10,
        top: 10,
        width: 100,
        height: 50,
      }),
    } as HTMLElement;
    expect(pointerPosition(element, { clientX: 60, clientY: 35 })).toEqual({
      x: 0.5,
      y: 0.5,
    });
    expect(pointerPosition(element, { clientX: 500, clientY: -5 })).toEqual({
      x: 1,
      y: 0,
    });
  });

  it("presses shortcut keys in order and releases them in reverse", () => {
    const events = shortcutEvents("ctrl-alt-del");
    expect(events.map((event) => (event as { code: string }).code)).toEqual([
      "ControlLeft",
      "AltLeft",
      "Delete",
      "Delete",
      "AltLeft",
      "ControlLeft",
    ]);
    expect(
      events.slice(0, 3).every((event) => (event as { down: boolean }).down),
    ).toBe(true);
  });
});
