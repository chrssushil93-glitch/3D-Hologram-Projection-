# LumaGrid AIR Studio v0.1

Simulator-led MVP of the LumaGrid AIR software platform: author a 3D object, place it in an XYZ display volume, preview it as voxels from a 180° viewing arc, compile it into a hardware-neutral job package, and run that job on a virtual machine.

**Simulation only.** This software cannot make light appear in air. Producing visible volumetric images needs a validated optical engine (plasma + CGH research track), laser-safety engineering and a vendor adapter. None of that exists here, and nothing in this app claims it does.

## Run

Requires Node 18+. No install step (Three.js is vendored in `vendor/`).

```
npm start          # http://localhost:5173
npm test           # 38 unit tests (core logic + CGH simulation)
```

## What is in v0.1

| Plan item | Where |
|---|---|
| 3D import (GLB / glTF) + 4 sample models | `studio.js` |
| XYZ placement, size and yaw in a 2 × 1 × 2 m volume (X width, Y depth, Z height; editable) | `studio.js`, `src/spatial.js` |
| Animation: yaw spin, duration, fps, timeline scrubber | `studio.js` |
| Voxel representation with adjustable density; samples outside the volume turn red | `src/spatial.js` (`sampleTriangles`, `voxelize`) |
| 180° viewer: orbit, −90° / 0° / +90° viewpoints, and a tri-view | `studio.js` |
| Two separate preview modes: Visual preview and Optical simulation, with a standing caveat that neither predicts real hardware | `studio.js` |
| Spatial compiler → hardware-neutral job package (`lumagrid.air.job/0.1`, SHA-256 checked) | `src/job.js` |
| Compile checks: geometry inside volume (including the full spin sweep), voxel budget, backend availability, colour channels | `src/job.js` |
| CGH bench: phase hologram for an ideal SLM, numerical reconstruction per depth plane, formed-point metrics, aliasing check | `src/cgh.js`, `src/fft.js`, Studio section 8 |
| Device simulator with the LumaGrid Device Protocol states: Disconnected, Safe, Ready, Armed, Running, Fault | `src/device.js` |
| Machine panel: connect, send job, self-check, arm (operator name required), start/stop, E-STOP, interlock, fault reset, audit log | `studio.js`, `src/device.js` |

## CGH bench (what it does and does not tell you)

Studio section 8 takes the compiled job's voxels and runs them through a simulated holographic display:

1. Up to N voxels (default 250) are mapped onto a **millimetre-scale bench volume**: lateral extent ±0.8 mm, depth 190–210 mm in front of a 256 × 256 px SLM (12.5 µm pitch, 532 nm). The job's metre-scale volume is scaled onto this; it is not a claim that a 2 × 1 × 2 m image is possible.
2. A phase-only hologram is built by summing converging waves from every point (point-source method), then quantised to the chosen number of phase levels. Optionally a weighted Gerchberg-Saxton optimiser refines it: it keeps only the phase at the target pixels on every depth plane, propagates back, and re-weights points that came out too bright or too weak.
3. The light is propagated numerically (angular spectrum) to nine depth planes and each point is scored: its brightest pixel against the plane average. A point counts as formed at 5× or more.
4. Points whose fringes are finer than the SLM pixel pitch can show are counted as aliased.

Example from the default torus knot (250 points, 256 phase levels, ideal SLM): the point-source hologram forms every point with a mean peak of 173× the plane average, weakest point 12×, 42% of each plane's light on target pixels. With 10 optimiser iterations that becomes 357×, weakest 73×, 47% on target (the gain is much larger on a 14-point toy case, where the same optimiser reaches roughly 20× the point-source mean). With 2 phase levels instead of 256 the point-source mean drops to 70×. Optional non-idealities (10 / 30% pixel crosstalk, 10° / 30° phase noise) are applied when reconstructing; 30% crosstalk plus 30° noise takes the optimised mean from 357× to 261×.

Assumptions that make this an **upper bound, not a prediction**: perfect phase response, perfect plane-wave illumination, no zero-order or stray light, no pixel crosstalk, no speckle from real optics. Nothing here measures brightness, safety or visibility, and the compute times (about 1 s in a browser) belong to the simulation only. A single SLM's pixel count limits the size and depth of volume it can address, so a metre-scale volume is far beyond this bench; closing that gap is what a real optical-engine study would have to do.

## Safety model (mirrors what a real adapter must keep)

- Emission is only possible in Armed / Running. Safe and Ready mean output disabled.
- Arming needs a named operator, a loaded job and a closed interlock.
- Emergency stop is always accepted and latches Fault. An open interlock does the same. Recovery needs an on-site reset with the interlock closed, followed by a fresh self-check.
- Devices verify the job checksum and reject modified, wrong-schema or wrong-backend packages.
- Backends `plasma-cgh` and `slm-cgh` are registered but marked unavailable. The compiler refuses to target them. No performance numbers are invented for them.

## Coordinates

LumaGrid internal: X = width, Y = depth (away from viewers), Z = height, metres. The volume is centred on X and Y and spans Z from 0 to its height. Viewers stand on a floor arc at −Y; angle 0° is straight ahead, ±90° are the sides. Three.js is Y-up, so a luma point (x, y, z) is drawn at (x, z, y).

Spin rotates about the vertical axis through the volume centre (pivot 0, 0). An object placed off-centre therefore orbits, and the compiler checks the whole sweep.

## Layout

```
index.html, styles.css, studio.js   Studio UI (Three.js)
src/spatial.js                      sampling, voxelising, placement, volume checks, viewer arc
src/job.js                          compiler, job schema, backend registry
src/device.js                       virtual machine and protocol states
src/cgh.js, src/fft.js              CGH bench simulation (point-source hologram, angular-spectrum propagation)
src/sha256.js                       checksum shared by browser and Node
scripts/dev-server.js                tiny local static server (the live site is plain static files)
vercel.json                         static-site config for hosting
test/core.test.js, cgh.test.js     unit tests
vendor/three/                       Three.js r170 (MIT, see LICENSE)
```

## Known limits

- Colour comes from each mesh's base material colour. Textures and vertex colours are ignored.
- GLB with embedded data is expected; glTF with external files is not resolved.
- Spin is the only animation type in the job format so far. Skeletal and keyframe animation are not compiled.
- The job stores base voxels plus an animation spec rather than baked frames.
- Optical-simulation mode shows voxels, not a physical model: no brightness, colour accuracy, plasma lifetime or ambient-light effects.
- The optimiser targets the single nearest pixel per point and the score measures the 3×3 around it, so part of its gain is tuning to this metric; it makes no statement about image quality for a viewer. Crosstalk and phase noise are simple models, not measured SLM data.
- The CGH bench is analysis only: the device simulator still plays the plain voxel job, and `slm-cgh` / `plasma-cgh` remain unavailable backends. Only the bench-scale point-source method and weighted Gerchberg-Saxton are implemented (no zero-order handling, no baked per-frame animation).
- Not built yet: cloud API, accounts, MQTT edge runtime, hardware adapters. The device protocol and job schema are the seams where those plug in.

## Suggested next steps

1. Fit the SLM non-idealities to a real device's measured data (phase response, fill factor, fringing) instead of the simple models.
2. Add keyframe animation to the job format and feed per-frame holograms through the bench.
3. Wrap the device simulator in an MQTT edge runtime with the same state machine.
4. Agree the optical-engine adapter contract with the optics lab before any hardware integration.
