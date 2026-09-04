/**
 * Records the animation canvas to a video file via MediaRecorder.
 *
 * Real-time by design: what lands in the file is exactly what the preview
 * showed, jank included - the point of this export is to talk about what the
 * animation actually did. A product-grade offline exporter (WebCodecs with a
 * fixed frame clock, muxed to MP4) belongs to the video-export milestone.
 */

const CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
];

export function pickRecordingType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of CANDIDATES) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}

export class CanvasRecorder {
  constructor(canvas, { fps = 60, videoBitsPerSecond = 12_000_000 } = {}) {
    this.canvas = canvas;
    this.fps = fps;
    this.videoBitsPerSecond = videoBitsPerSecond;
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    this.mimeType = pickRecordingType();
  }

  get supported() {
    return this.mimeType !== null;
  }

  get recording() {
    return this.recorder?.state === 'recording';
  }

  get ext() {
    return this.mimeType?.includes('mp4') ? 'mp4' : 'webm';
  }

  start() {
    if (!this.supported || this.recording) return false;
    this.chunks = [];
    this.stream = this.canvas.captureStream(this.fps);
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: this.mimeType,
      videoBitsPerSecond: this.videoBitsPerSecond,
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data?.size) this.chunks.push(e.data);
    };
    this.recorder.start();
    return true;
  }

  /** Nudge one more frame out of a canvas that has stopped repainting. */
  captureFrame() {
    const track = this.stream?.getVideoTracks?.()[0];
    if (track?.requestFrame) track.requestFrame();
    else this.stream?.requestFrame?.();
  }

  /** @returns {Promise<Blob|null>} null if nothing was captured */
  stop() {
    return new Promise((resolve) => {
      if (!this.recorder || this.recorder.state === 'inactive') {
        resolve(null);
        return;
      }
      this.recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mimeType });
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = null;
        this.recorder = null;
        this.chunks = [];
        resolve(blob.size ? blob : null);
      };
      this.recorder.stop();
    });
  }
}
