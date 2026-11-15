// SPDX-License-Identifier: Apache-2.0
// Laser pointer geometry (remote control, F4): where the dot goes on the shell, which draws it in a trusted layer
// above the content iframe (the content is never touched and the iframe protocol does not change).
//
// Coordinates arrive as integers 0..10000 along the logical canvas width and height. The runtime scales the canvas
// into the iframe viewport with s = min(w / W, h / H), centred (the letterbox), so the same formula maps a canvas
// point to the host. The dot's diameter is 1.2 % of the canvas height, scaled.

/** Largest coordinate (the canvas edge). Same as `COORD_MAX` of `@pptaken/realtime`. */
export const LASER_COORD_MAX = 10_000;
/** The dot hides after this long without a new position. */
export const LASER_TIMEOUT_MS = 1500;
/** Dot diameter as a fraction of the canvas height. */
export const LASER_SIZE = 0.012;

export interface LaserGeometry {
  /** Centre of the dot in host CSS pixels. */
  x: number;
  y: number;
  /** Diameter in CSS pixels. */
  size: number;
}

/** Host position of a canvas point; `null` when a size is not positive or a coordinate is out of range. */
export function laserGeometry(
  view: { width: number; height: number },
  canvas: { width: number; height: number },
  px: number,
  py: number,
): LaserGeometry | null {
  if (!(view.width > 0 && view.height > 0 && canvas.width > 0 && canvas.height > 0)) return null;
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  if (px < 0 || py < 0 || px > LASER_COORD_MAX || py > LASER_COORD_MAX) return null;
  const s = Math.min(view.width / canvas.width, view.height / canvas.height);
  const offsetX = (view.width - canvas.width * s) / 2;
  const offsetY = (view.height - canvas.height * s) / 2;
  return {
    x: offsetX + (px / LASER_COORD_MAX) * canvas.width * s,
    y: offsetY + (py / LASER_COORD_MAX) * canvas.height * s,
    size: Math.max(LASER_SIZE * canvas.height * s, 2),
  };
}
