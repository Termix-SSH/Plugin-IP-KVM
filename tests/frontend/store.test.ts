import { afterEach, describe, expect, it, vi } from "vitest";

const devices = vi.hoisted(() => vi.fn());
vi.mock("../../src/frontend/api", () => ({
  sharedApi: () => ({ devices }),
}));

import {
  deviceForHost,
  reloadKnown,
  resetStore,
} from "../../src/frontend/store";

afterEach(() => {
  resetStore();
  devices.mockReset();
  vi.useRealTimers();
});

describe("device store", () => {
  it("runs no timer and fetches again only when the list is old", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const interval = vi.spyOn(globalThis, "setInterval");
    devices.mockResolvedValue([{ id: 1, hostId: 5 }]);
    await reloadKnown();
    expect(deviceForHost(5)?.id).toBe(1);
    expect(deviceForHost(6)).toBeUndefined();
    expect(devices).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1_000_000 + 61_000);
    deviceForHost(5);
    expect(devices).toHaveBeenCalledTimes(2);
    expect(interval).not.toHaveBeenCalled();
  });
});
