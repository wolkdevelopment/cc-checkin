/* The door's camera: reads QR codes from the live video. Uses the phone's built-in barcode reader
   where there is one (most Android phones) and our own decoder everywhere else (iPhones). */
import { scanImage } from "./qr.js";

export function createScanner(video, onText) {
  let stream = null, running = false, timer = null, detector = null, frame = 0;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  async function start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("This browser can't use the camera on this page. Use Find by name, or open the page in Safari or Chrome.");
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    } catch (e) {
      const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
      throw new Error(denied ? "The camera is blocked for this site. Allow it in the browser's settings, then reload." : "Couldn't start the camera (" + (e && e.name ? e.name : "error") + ").");
    }
    video.setAttribute("playsinline", "");
    video.muted = true;
    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* starts once frames arrive */ }
    if (!detector && "BarcodeDetector" in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes("qr_code")) detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      } catch (e) { detector = null; }
    }
    running = true;
    loop();
  }

  async function loop() {
    timer = null;
    if (!running) return;
    let text = null;
    if (video.readyState >= 2 && video.videoWidth) {
      frame++;
      // The built-in reader most of the time; our decoder every third frame as a backstop.
      if (detector && frame % 3 !== 0) {
        try { const codes = await detector.detect(video); if (codes.length) text = codes[0].rawValue; } catch (e) { detector = null; }
      } else {
        const vw = video.videoWidth, vh = video.videoHeight, s = Math.min(1, 720 / Math.max(vw, vh));
        const w = Math.round(vw * s), h = Math.round(vh * s);
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        text = scanImage(ctx.getImageData(0, 0, w, h).data, w, h);
      }
    }
    if (!running) return;
    if (text) { running = false; onText(text); return; }
    timer = setTimeout(loop, 70);
  }

  function ended() { return !stream || stream.getVideoTracks().every(t => t.readyState === "ended"); }
  return {
    start,
    pause() { running = false; clearTimeout(timer); timer = null; },
    async resume() {
      if (!stream) return;
      if (ended()) { stream = null; await start(); return; }
      if (!running) { running = true; loop(); }
    },
    stop() { running = false; clearTimeout(timer); if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null; },
    get on() { return !!stream; },
    get native() { return !!detector; }
  };
}
