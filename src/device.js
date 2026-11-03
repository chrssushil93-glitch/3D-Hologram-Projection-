// LumaGrid AIR - Virtual display machine (device simulator) and the LumaGrid Device Protocol states.
import { verifyJobChecksum, JOB_SCHEMA, BACKENDS } from './job.js';

export const STATES = Object.freeze({
  DISCONNECTED: 'Disconnected',
  SAFE: 'Safe', // connected, output disabled
  READY: 'Ready', // device and calibration checks passed
  ARMED: 'Armed', // authorised operator has enabled the system
  RUNNING: 'Running', // approved display job executing
  FAULT: 'Fault', // safety or equipment fault
});

/**
 * Simulated machine. Mirrors the contract a real optical-engine adapter must keep:
 *  - the machine's own safety layer has final authority; software can request, never force
 *  - emission is only possible in Armed/Running
 *  - an open interlock or emergency stop always wins and latches a Fault
 */
export class SimulatedDevice {
  constructor({ id = 'sim-air-01', backend = 'simulation', now = () => Date.now() } = {}) {
    this.id = id;
    this.backend = backend;
    this.now = now;
    this.state = STATES.DISCONNECTED;
    this.interlockClosed = true;
    this.calibrated = false;
    this.job = null;
    this.frame = 0;
    this.elapsedMs = 0;
    this.log = [];
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  _emit() { for (const fn of this.listeners) fn(this.snapshot()); }

  _log(level, message) {
    this.log.push({ t: this.now(), level, state: this.state, message });
    if (this.log.length > 500) this.log.shift();
  }

  _to(state, message, level = 'info') {
    this.state = state;
    this._log(level, message);
    this._emit();
  }

  _refuse(message) {
    this._log('warn', `Refused: ${message}`);
    this._emit();
    return { ok: false, error: message };
  }

  snapshot() {
    return {
      id: this.id,
      backend: this.backend,
      state: this.state,
      interlockClosed: this.interlockClosed,
      calibrated: this.calibrated,
      jobId: this.job ? this.job.id : null,
      frame: this.frame,
      frameCount: this.job ? this.job.animation.frameCount : 0,
      emitting: this.state === STATES.ARMED || this.state === STATES.RUNNING,
    };
  }

  connect() {
    if (this.state !== STATES.DISCONNECTED) return this._refuse(`already ${this.state}`);
    this._to(STATES.SAFE, 'Connected. Output disabled.');
    return { ok: true };
  }

  disconnect() {
    this.job = null; this.frame = 0; this.elapsedMs = 0; this.calibrated = false;
    this._to(STATES.DISCONNECTED, 'Disconnected.');
    return { ok: true };
  }

  /** Receive and validate a job package. Does not start it. */
  loadJob(job) {
    if (this.state === STATES.DISCONNECTED) return this._refuse('not connected');
    if (this.state === STATES.RUNNING) return this._refuse('a job is running');
    if (this.state === STATES.FAULT) return this._refuse('device is in Fault');
    if (!job || job.schema !== JOB_SCHEMA) return this._refuse('unknown job schema');
    if (!verifyJobChecksum(job)) return this._refuse('job checksum mismatch (package modified or corrupted)');
    if (job.backend !== this.backend) return this._refuse(`job targets "${job.backend}", device runs "${this.backend}"`);
    if (!BACKENDS[job.backend] || !BACKENDS[job.backend].available) return this._refuse('backend not available');
    this.job = job; this.frame = 0; this.elapsedMs = 0;
    this._log('info', `Job ${job.id} loaded: ${job.voxelCount} voxels, ${job.animation.frameCount} frames.`);
    this._emit();
    return { ok: true };
  }

  /** Run self-checks and calibration. Safe -> Ready. */
  prepare() {
    if (this.state !== STATES.SAFE) return this._refuse(`prepare needs Safe, device is ${this.state}`);
    if (!this.interlockClosed) return this._refuse('interlock open');
    this.calibrated = true;
    this._to(STATES.READY, 'Self-check and calibration passed.');
    return { ok: true };
  }

  /** Operator authorisation. Ready -> Armed. Requires a loaded job and a closed interlock. */
  arm(operator) {
    if (this.state !== STATES.READY) return this._refuse(`arm needs Ready, device is ${this.state}`);
    if (!operator || !String(operator).trim()) return this._refuse('operator identity required to arm');
    if (!this.interlockClosed) return this._refuse('interlock open');
    if (!this.job) return this._refuse('no job loaded');
    this.operator = String(operator).trim();
    this._to(STATES.ARMED, `Armed by ${this.operator}.`, 'warn');
    return { ok: true };
  }

  disarm() {
    if (this.state !== STATES.ARMED && this.state !== STATES.RUNNING) return this._refuse(`nothing to disarm in ${this.state}`);
    this.frame = 0; this.elapsedMs = 0;
    this._to(STATES.READY, 'Disarmed. Output disabled.');
    return { ok: true };
  }

  start() {
    if (this.state !== STATES.ARMED) return this._refuse(`start needs Armed, device is ${this.state}`);
    this.frame = 0; this.elapsedMs = 0;
    this._to(STATES.RUNNING, `Playing job ${this.job.id}.`);
    return { ok: true };
  }

  stop() {
    if (this.state !== STATES.RUNNING) return this._refuse(`stop needs Running, device is ${this.state}`);
    this._to(STATES.ARMED, 'Playback stopped. Still armed.');
    return { ok: true };
  }

  /** Physical emergency stop. Always accepted; latches Fault. */
  emergencyStop() {
    if (this.state === STATES.DISCONNECTED) return this._refuse('not connected');
    this.calibrated = false;
    this._to(STATES.FAULT, 'EMERGENCY STOP. Output disabled; manual reset required.', 'error');
    return { ok: true };
  }

  /** Simulate opening/closing the physical safety interlock. */
  setInterlock(closed) {
    this.interlockClosed = !!closed;
    if (!closed) {
      this._log('warn', 'Interlock opened.');
      if (this.state === STATES.ARMED || this.state === STATES.RUNNING || this.state === STATES.READY) {
        this.calibrated = false;
        this._to(STATES.FAULT, 'Interlock opened. Output disabled; manual reset required.', 'error');
        return;
      }
    } else {
      this._log('info', 'Interlock closed.');
    }
    this._emit();
  }

  /** On-site manual reset after a fault. Fault -> Safe. Refused while the interlock is open. */
  resetFault() {
    if (this.state !== STATES.FAULT) return this._refuse(`nothing to reset in ${this.state}`);
    if (!this.interlockClosed) return this._refuse('close the interlock before resetting');
    this.frame = 0; this.elapsedMs = 0;
    this._to(STATES.SAFE, 'Fault cleared by on-site reset. Output disabled.');
    return { ok: true };
  }

  /** Advance playback. Call with elapsed milliseconds. Loops until stopped. */
  tick(dtMs) {
    if (this.state !== STATES.RUNNING || !this.job) return;
    const { fps, durationMs, frameCount } = this.job.animation;
    this.elapsedMs = (this.elapsedMs + dtMs) % durationMs;
    this.frame = Math.min(frameCount - 1, Math.floor((this.elapsedMs / 1000) * fps));
    this._emit();
  }

  /** Current yaw (degrees) of the playing job, for the viewer. */
  currentYawDeg() {
    if (!this.job) return 0;
    return this.job.animation.spinDegPerSec * (this.elapsedMs / 1000);
  }
}
