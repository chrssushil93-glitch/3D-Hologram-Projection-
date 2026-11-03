# LumaGrid AIR Studio v0.1

Simulator-led MVP of the LumaGrid AIR software platform: author a 3D object, place it in an XYZ display volume, preview it as voxels from a 180° viewing arc, compile it into a hardware-neutral job package, and run that job on a virtual machine.

**Simulation only.** This software cannot make light appear in air. Producing visible volumetric images needs a validated optical engine (plasma + CGH research track), laser-safety engineering and a vendor adapter. None of that exists here, and nothing in this app claims it does.

## Run

Requires Node 18+. No install step (Three.js is vendored in `vendor/`).

```
npm start          # http://localhost:5173
npm test           # 22 unit tests for the core logic
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
| Device simulator with the LumaGrid Device Protocol states: Disconnected, Safe, Ready, Armed, Running, Fault | `src/device.js` |
| Machine panel: connect, send job, self-check, arm (operator name required), start/stop, E-STOP, interlock, fault reset, audit log | `studio.js`, `src/device.js` |

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
src/sha256.js                       checksum shared by browser and Node
server.js                           tiny static server
test/core.test.js                   unit tests
vendor/three/                       Three.js r170 (MIT, see LICENSE)
```

## Known limits

- Colour comes from each mesh's base material colour. Textures and vertex colours are ignored.
- GLB with embedded data is expected; glTF with external files is not resolved.
- Spin is the only animation type in the job format so far. Skeletal and keyframe animation are not compiled.
- The job stores base voxels plus an animation spec rather than baked frames.
- Optical-simulation mode shows voxels, not a physical model: no brightness, colour accuracy, plasma lifetime or ambient-light effects.
- Not built yet: cloud API, accounts, MQTT edge runtime, the CGH / `slmsuite` backend, hardware adapters. The device protocol and job schema are the seams where those plug in.

## Suggested next steps

1. Run the CGH backend in simulation: voxel positions → SLM phase pattern (`slmsuite`), still no hardware.
2. Add keyframe animation to the job format.
3. Wrap the device simulator in an MQTT edge runtime with the same state machine.
4. Agree the plasma/CGH adapter contract with the optics lab before any hardware integration.
