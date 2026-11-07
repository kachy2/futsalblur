# Head detector model (head.onnx)

FutsalBlur finds heads with a small object detector that runs in the browser (ONNX Runtime Web). This file says where the
model comes from, how it was made, how well it works and what it is not good at.

## Summary
| | |
|---|---|
| File | `head.onnx`, 15.4 MB, sha256 `e140766c1ba59f6bffadbdd9fecece53c68a75b527dc28ef835fee2f9b48049f` |
| Input | `pixel_values` [1, 3, 640, 640]: one 640 x 640 tile, RGB scaled to 0-1, no mean or std |
| Outputs | `logits` [1, 300, 1] (sigmoid: head), `pred_boxes` [1, 300, 4] centre x, centre y, width, height, relative to the tile |
| Architecture | D-FINE-N (nano) real-time detector, one class: head |
| Starting weights | [`ustc-community/dfine-nano-coco`](https://huggingface.co/ustc-community/dfine-nano-coco) (D-FINE-N trained on COCO 2017), Apache-2.0 |
| License of these weights | MIT, like the rest of FutsalBlur. The starting weights' license and what was changed: [LICENSE-Apache-2.0.txt](LICENSE-Apache-2.0.txt) |
| Version | 1 (November 2026) |

## How it was trained
- **Footage**: the maintainer's own recordings of amateur futsal, filmed with a phone on a tripod (4K, two venues, day and
  dusk light). The footage and the labels are not published; only the weights are.
- **Labels, made by permissively licensed models**:
  - D-FINE-N (COCO, Apache-2.0) finds the people in each frame.
  - [OWLv2](https://huggingface.co/google/owlv2-base-patch16-ensemble) (Apache-2.0) looks at an enlarged window over the
    top of each person and picks the most likely head box. The box is extended down by 20% of its height so it reaches
    the chin.
  - MediaPipe BlazeFace short range (Apache-2.0) finds clear faces that got no head box. Those places are left out of
    training (neither head nor background).
  - Places where the person detector keeps firing on fixed objects (poles, signs, the camera's own shield), and the area
    around them, are background. Other uncertain places are left out of training rather than guessed.
- No face or head annotation made by people and no output of any anonymization software was used to train this model.
- **Training**: 20 epochs from the COCO weights on 640 x 640 crops at 0.4-0.75 of the 4K scale, with flips, colour and
  brightness changes, re-compression and slight blur. The weights of the last epoch (exponential moving average) are
  shipped.

## How well it works
Measured on 4,056 frames of the maintainer's recordings that were not used for training, with the app's default blur (an
oval over each box grown by 15% on every side).

| Score at least | Faces at least half blurred | Faces at least 90% blurred | Share of the frame blurred |
|---|---|---|---|
| 0.05 | 100.00% | 99.95% | 1.47% |
| 0.1 | 99.82% | 99.73% | 1.08% |
| 0.2 | 99.80% | 99.36% | 0.75% |
| **0.275 (default)** | **99.73%** | **98.75%** | **0.50%** |
| 0.3 | 99.64% | 98.45% | 0.43% |

- Faces: the 4,395 faces that an independent face detector (OpenCV YuNet, score 0.7 or more) found in those frames. YuNet
  was used only for this measurement, not for training.
- At 0.275, 12 of those faces were less than half blurred: 10 were a face printed on a poster behind the fence (seen in
  two recordings), 1 was a false find of the face detector (on a torso), and 1 was a real face, 48% blurred.
- Blurs on things that are not heads, counted by eye on a random sample of 70 boxes: at 0.2, about 1.3 per frame (95%
  interval 0.9-1.8); at 0.275, about 0.5 per frame (0.2-0.8). Most are torsos, hands and legs next to a head; some are
  poles and signs.
- Other places and cameras (416 frames from 8 clips filmed at another venue or with other cameras, 809 faces): every
  face was at least half blurred at 0.275. At 0.2 the eye-checked sample had 5 boxes that were not heads out of 7 in
  these clips, against 17 of 56 at the training venues. The sample is small, but it points to more false blurs at new
  venues.

## Limits
- Trained on fixed-camera futsal from two venues. Other sports, venues, camera heights and lenses are less tested.
- Very small or motion-blurred far heads can be missed at higher scores. Lower the score if you need more coverage.
- Some false blurs remain on torsos, hands and fixed objects (poles, signs).
- Faces printed on posters, banners or screens are often not blurred.
- Speed in the browser on a CPU is far below real time for 4K video (about 0.02x real time on two CPU threads). A
  graphics chip (WebGPU) helps where the browser supports it.

## Lineage note
The starting weights and the labelling models are Apache-2.0, but the images they were trained on (COCO; OWLv2's
web-scale images) come with their own terms, some of them non-commercial. If that matters for your use, check those
sources.

## Intended use
Blurring faces and heads in sports videos before sharing them. Not for identifying, tracking or counting people.
