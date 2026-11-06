import { describe, expect, it } from "vitest";
import { parseManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import manifest from "../../manifest.json";
import { registerOperations } from "../../src/backend/operations.js";
import type { Service } from "../../src/backend/service.js";

type Declared = {
  id: string;
  risk: string;
  permission: string;
  dryRun?: string;
};

const actions = (
  manifest.contributes as { operations: { actions: Declared[] } }
).operations.actions;

describe("declared actions", () => {
  it("is a valid manifest", () => {
    expect(parseManifest(manifest).errors ?? []).toEqual([]);
  });

  it("has a handler for every declared action and nothing else", () => {
    const registered: string[] = [];
    const ctx = {
      operations: {
        register: (id: string) => {
          registered.push(id);
        },
      },
    } as unknown as PluginContext;
    registerOperations(ctx, {} as Service);
    expect([...registered].sort()).toEqual(actions.map((a) => a.id).sort());
  });

  it("needs a permission and a dry run for anything that changes a machine", () => {
    for (const action of actions) {
      if (action.risk === "read") continue;
      expect(["power", "media"]).toContain(action.permission);
      expect(action.dryRun).toBeTruthy();
    }
  });

  it("marks hard power changes as destructive", () => {
    const risk = (id: string) => actions.find((a) => a.id === id)?.risk;
    expect(risk("ip-kvm.power-off")).toBe("destructive");
    expect(risk("ip-kvm.reset")).toBe("destructive");
    expect(risk("ip-kvm.power-on")).toBe("change");
  });
});

describe("handlers", () => {
  const device = {
    id: 4,
    hostId: null as number | null,
    name: "rack-kvm",
    status: "up",
    reading: { power: "on" },
  };
  const calls: string[] = [];
  const service = {
    list: async () => [device],
    get: async () => device,
    poll: async () => device,
    power: async (...args: unknown[]) => {
      calls.push(`power ${args.join(",")}`);
    },
    wake: async (...args: unknown[]) => {
      calls.push(`wake ${args.join(",")}`);
    },
    mediaEject: async (...args: unknown[]) => {
      calls.push(`eject ${args.join(",")}`);
    },
  } as unknown as Service;

  const handlers = new Map<
    string,
    {
      run: (input: Record<string, unknown>) => Promise<any>;
      describe?: (input: Record<string, unknown>) => Promise<string>;
    }
  >();
  let access = true;
  const checked: Array<[number, string]> = [];
  registerOperations(
    {
      operations: {
        register: (id: string, handler: never) => handlers.set(id, handler),
      },
      hosts: {
        checkAccess: async (hostId: number, level: string) => {
          checked.push([hostId, level]);
          return { hasAccess: access };
        },
      },
    } as unknown as PluginContext,
    service,
  );

  it("describes a power change without making it", async () => {
    const text = await handlers.get("ip-kvm.reset")!.describe!({ device: "4" });
    expect(text).toBe("Would reset rack-kvm");
    expect(calls).toEqual([]);
  });

  it("runs power, wake and eject actions", async () => {
    await handlers.get("ip-kvm.power-on")!.run({ device: "4" });
    await handlers.get("ip-kvm.graceful-shutdown")!.run({ device: "4" });
    await handlers.get("ip-kvm.power-off")!.run({ device: "4" });
    await handlers.get("ip-kvm.reset")!.run({ device: "4" });
    await handlers.get("ip-kvm.wake")!.run({ device: "4" });
    await handlers.get("ip-kvm.eject-media")!.run({ device: "4" });
    expect(calls).toEqual([
      "power 4,on",
      "power 4,graceful-shutdown",
      "power 4,off",
      "power 4,reset",
      "wake 4",
      "eject 4",
    ]);
  });

  it("checks the linked host before changing anything", async () => {
    device.hostId = 12;
    access = false;
    calls.length = 0;
    await expect(
      handlers.get("ip-kvm.power-off")!.run({ device: "4" }),
    ).rejects.toThrow(/access/);
    expect(calls).toEqual([]);
    expect(checked.at(-1)).toEqual([12, "edit"]);
    device.hostId = null;
    access = true;
  });

  it("reports offline KVMs as a failing signal", async () => {
    const ok = await handlers.get("ip-kvm.list-devices")!.run({});
    expect(ok.data.status).toBe("ok");
    device.status = "down";
    const bad = await handlers.get("ip-kvm.list-devices")!.run({});
    expect(bad.data).toMatchObject({ status: "fail", value: 1 });
    expect(bad.summary).toBe("1 need attention");
    device.status = "up";
  });

  it("reports the power state as a status", async () => {
    const result = await handlers.get("ip-kvm.power-state")!.run({
      device: "4",
    });
    expect(result.data).toMatchObject({ value: "on", status: "ok" });
  });
});
