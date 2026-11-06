import { describe, expect, it } from "vitest";
import { keyName } from "../../src/frontend/input";

const key = (code: string, keyCode: number, location = 0) => ({
  code,
  keyCode,
  location,
});

describe("keyName", () => {
  it("uses code when the browser fills it", () => {
    expect(keyName(key("KeyA", 65))).toBe("KeyA");
  });

  it("falls back to keyCode when code is empty", () => {
    expect(keyName(key("", 65))).toBe("KeyA");
    expect(keyName(key("", 49))).toBe("Digit1");
    expect(keyName(key("", 13))).toBe("Enter");
    expect(keyName(key("", 8))).toBe("Backspace");
    expect(keyName(key("", 115))).toBe("F4");
    expect(keyName(key("", 190))).toBe("Period");
    expect(keyName(key("Unidentified", 32))).toBe("Space");
  });

  it("picks the side for modifiers", () => {
    expect(keyName(key("", 16, 1))).toBe("ShiftLeft");
    expect(keyName(key("", 17, 2))).toBe("ControlRight");
    expect(keyName(key("", 13, 3))).toBe("NumpadEnter");
  });

  it("returns nothing for keys it does not know", () => {
    expect(keyName(key("", 229))).toBe("");
  });
});
