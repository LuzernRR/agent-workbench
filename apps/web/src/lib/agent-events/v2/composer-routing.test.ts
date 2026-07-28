import { describe, expect, it } from "vitest";
import {
  routeV2ComposerClick,
  routeV2ComposerKey,
  type V2ComposerKeyInput
} from "./composer-routing";

const enter: V2ComposerKeyInput = {
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  repeat: false,
  isComposing: false,
  nativeIsComposing: false
};

describe("v2 composer routing", () => {
  it("routes non-running Enter, Ctrl+Enter and Cmd+Enter to ordinary send", () => {
    expect(routeV2ComposerKey(enter, false)).toBe("send");
    expect(routeV2ComposerKey({ ...enter, ctrlKey: true }, false)).toBe("send");
    expect(routeV2ComposerKey({ ...enter, metaKey: true }, false)).toBe("send");
  });

  it("separates enqueue and steer while a run is active", () => {
    expect(routeV2ComposerKey(enter, true)).toBe("enqueue");
    expect(routeV2ComposerKey({ ...enter, ctrlKey: true }, true)).toBe("steer");
    expect(routeV2ComposerKey({ ...enter, metaKey: true }, true)).toBe("steer");
  });

  it("always preserves newline, IME composition and key repeat", () => {
    expect(routeV2ComposerKey({ ...enter, shiftKey: true }, true)).toBe("newline");
    expect(routeV2ComposerKey({ ...enter, shiftKey: true }, false)).toBe("newline");
    expect(routeV2ComposerKey({ ...enter, isComposing: true }, true)).toBe("ignore");
    expect(routeV2ComposerKey({ ...enter, nativeIsComposing: true }, true)).toBe("ignore");
    expect(routeV2ComposerKey({ ...enter, repeat: true }, true)).toBe("ignore");
    expect(routeV2ComposerKey({ ...enter, key: "A" }, true)).toBe("ignore");
  });

  it("uses the explicit mobile selection only for active runs", () => {
    expect(routeV2ComposerClick(true, "enqueue")).toBe("enqueue");
    expect(routeV2ComposerClick(true, "steer")).toBe("steer");
    expect(routeV2ComposerClick(false, "steer")).toBe("send");
  });
});
