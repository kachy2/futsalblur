# FutsalBlur — blur the faces in your game videos, in your browser

[한국어](README.ko.md) · **Open the app: https://kachy2.github.io/futsalblur/**

A free, open-source tool that finds the heads of the players in a sports video (phone on a tripod, futsal/soccer and
similar) and blurs them, so the video can be shared without showing who is who, while the play stays easy to follow.

- **No install** — runs in the browser (Chrome/Edge on a PC recommended)
- **No upload** — the video never leaves the device: detection, blurring and saving all happen in the browser
- **Adjustable** — choose how sure the detector must be before a box is blurred (presets 0.05 / 0.1 / 0.2 / 0.25 / 0.3 or any
  value; 0.25 is the default), how far the blur reaches beyond each head, its strength, and blur or mosaic
- **Detections out** — download the boxes the detector found (JSON) to use them elsewhere

The head detector was trained on the maintainer's own recordings with labels made by openly licensed models. At the
default settings it blurred 99.7% of the faces in 4,056 test frames while blurring 0.5% of the picture. How it was made,
how it was measured and its limits: [model card](web/public/models/NOTICE.md).

## How to use
1. Choose a video (MP4/MOV).
2. Click **Find heads** and wait (long 4K videos take long: try a short clip first).
3. Check frames in the preview; change the threshold and the blur until it looks right.
4. Click **Save blurred video**. The sound is copied as it is.

Check the result before you share it: no detector finds every face. Small, far or hidden faces can be missed.

## How it works
1. Every frame is decoded with WebCodecs. Every third frame is brought to 1080p detail (for 4K) and cut into
   640 px tiles that overlap by 96 px, and a small head detector (D-FINE-N fine-tuned to one class, "head") runs on
   each tile, on the graphics chip (WebGPU) where it helps, otherwise on CPU threads (WebAssembly).
2. Boxes are linked across frames; frames in between get interpolated boxes, and a head missed once keeps its box.
3. Saving decodes the video again, blurs a soft-edged oval over each grown box and encodes H.264 MP4.

## For developers
- `web/` — Svelte 5 + Vite app (analysis and export workers, TypeScript core checked against the reference tool)
- Tests — `npm test` (Vitest), `npx playwright test` (headless Chrome end to end)
- Build — `npm run build` (the model is `web/public/models/head.onnx`; `HEAD_ONNX=<model.onnx>` uses another one)

## License
MIT. Bundled components keep their licenses: see [LICENSE](LICENSE) and [web/public/models/NOTICE.md](web/public/models/NOTICE.md).
