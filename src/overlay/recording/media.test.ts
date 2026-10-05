// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

import { startMedia } from "./media.ts";

class CaptureTrack extends EventTarget {
  stopped = false;
  stop() {
    this.stopped = true;
  }
  requestFrame() {}
  restrictTo() {
    return Promise.resolve();
  }
}

const restorations: (() => void)[] = [];

afterEach(() => {
  for (const restore of restorations.splice(0)) restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback");
  Reflect.deleteProperty(HTMLVideoElement.prototype, "cancelVideoFrameCallback");
  Reflect.deleteProperty(navigator, "mediaDevices");
});

it("releases GIF-only sharing at its cap and preserves the completed GIF", async () => {
  const sourceTrack = new CaptureTrack();
  const outputTrack = new CaptureTrack();
  vi.stubGlobal("CanvasCaptureMediaStreamTrack", CaptureTrack);
  vi.stubGlobal("RestrictionTarget", { fromElement: () => Promise.resolve({}) });
  vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
  vi.stubGlobal("isSecureContext", true);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getDisplayMedia: () =>
        Promise.resolve({ getVideoTracks: () => [sourceTrack], getTracks: () => [sourceTrack] }),
    },
  });
  vi.spyOn(HTMLVideoElement.prototype, "srcObject", "set").mockImplementation(() => {});
  const captureStream = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    "captureStream",
  );
  const getContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  Object.defineProperties(HTMLCanvasElement.prototype, {
    captureStream: {
      configurable: true,
      value: () => ({ getVideoTracks: () => [outputTrack], getTracks: () => [outputTrack] }),
    },
    getContext: {
      configurable: true,
      value: () => ({
        clearRect() {},
        drawImage() {},
        getImageData: () => ({ data: new Uint8ClampedArray(8 * 8 * 4) }),
      }),
    },
  });
  if (captureStream === undefined || getContext === undefined)
    throw new Error("No canvas prototype methods");
  restorations.push(() =>
    Object.defineProperties(HTMLCanvasElement.prototype, { captureStream, getContext }),
  );
  vi.spyOn(HTMLVideoElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLVideoElement.prototype, "pause").mockImplementation(() => {});
  let next: VideoFrameRequestCallback | undefined;
  Object.defineProperties(HTMLVideoElement.prototype, {
    requestVideoFrameCallback: {
      configurable: true,
      value: (callback: VideoFrameRequestCallback) => {
        next = callback;
        return 1;
      },
    },
    cancelVideoFrameCallback: {
      configurable: true,
      value: () => {
        next = undefined;
      },
    },
  });
  const statuses: string[] = [];
  const media = startMedia(false, true, { x: 0, y: 0, w: 8, h: 8 }, (value) =>
    statuses.push(value.state === "failed" ? value.reason : value.state),
  );
  await vi.waitFor(() => expect(statuses.join("; ")).toContain("; on"));
  for (let index = 1; index <= 120; index += 1) {
    const callback = next;
    expect(callback).toBeDefined();
    next = undefined;
    callback?.(performance.now() + index * 200, {
      expectedDisplayTime: 0,
      height: 8,
      width: 8,
      mediaTime: 0,
      presentationTime: 0,
      presentedFrames: 1,
      processingDuration: 0,
    });
  }
  expect(sourceTrack.stopped).toBe(true);
  expect(outputTrack.stopped).toBe(true);
  expect(next).toBeUndefined();
  const result = await media.stop();
  expect(result.video.data).toBeUndefined();
  expect(result.gif?.meta).toMatchObject({ frames: 120, truncated: true });
  expect(result.gif?.data.size).toBeGreaterThan(0);
});
