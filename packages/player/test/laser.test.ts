// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { KEY_ACTIONS, keyCodeOf, LASER_COORD_MAX, laserGeometry } from "../dist/index.js";

describe("laser geometry", () => {
  const hd = { width: 1920, height: 1080 };
  const four3 = { width: 1440, height: 1080 };

  it("maps the canvas corners and centre without letterbox", () => {
    expect(laserGeometry({ width: 1920, height: 1080 }, hd, 0, 0)).toMatchObject({ x: 0, y: 0 });
    expect(laserGeometry({ width: 960, height: 540 }, hd, 10_000, 10_000)).toMatchObject({
      x: 960,
      y: 540,
    });
    const c = laserGeometry({ width: 1280, height: 720 }, hd, 5000, 5000);
    expect(c?.x).toBeCloseTo(640);
    expect(c?.y).toBeCloseTo(360);
    // 1.2 % of the canvas height, scaled.
    expect(c?.size).toBeCloseTo(1080 * 0.012 * (720 / 1080));
  });

  it("adds the letterbox offset (pillarbox for 4:3 on a wide view, bars for 16:9 on a tall one)", () => {
    // 4:3 canvas in a 1600×900 view: s = 900/1080, width 1200, offset 200.
    const a = laserGeometry({ width: 1600, height: 900 }, four3, 0, 10_000);
    expect(a?.x).toBeCloseTo(200);
    expect(a?.y).toBeCloseTo(900);
    // 16:9 canvas in a 800×800 view: s = 800/1920, height 450, offset 175.
    const b = laserGeometry({ width: 800, height: 800 }, hd, 10_000, 0);
    expect(b?.x).toBeCloseTo(800);
    expect(b?.y).toBeCloseTo(175);
  });

  it("refuses bad sizes and out-of-range points", () => {
    expect(laserGeometry({ width: 0, height: 10 }, hd, 1, 1)).toBeNull();
    expect(laserGeometry({ width: 10, height: 10 }, { width: 0, height: 1 }, 1, 1)).toBeNull();
    expect(laserGeometry({ width: 10, height: 10 }, hd, -1, 1)).toBeNull();
    expect(laserGeometry({ width: 10, height: 10 }, hd, 1, LASER_COORD_MAX + 1)).toBeNull();
    expect(laserGeometry({ width: 10, height: 10 }, hd, Number.NaN, 1)).toBeNull();
  });
});

describe("remote-control keys", () => {
  const key = (k: string) => ({
    key: k,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
  });
  it("maps r and k to the remote actions, which the shell leaves to the page", () => {
    expect(keyCodeOf(key("r"))).toBe("KeyR");
    expect(keyCodeOf(key("k"))).toBe("KeyK");
    expect(KEY_ACTIONS.KeyR).toBe("remote");
    expect(KEY_ACTIONS.KeyK).toBe("kick");
  });
});
