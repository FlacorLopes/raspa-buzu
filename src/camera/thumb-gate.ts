// Turns a stream of per-detection "thumb is up" readings into one release per gesture.
// Holding the thumb must not keep releasing buses: after a release the gate stays shut until
// the thumb drops (a detection without it, or the hand leaving the frame), and a thumb that is
// still up when the next bus arrives has to drop first. Pure logic, so it is unit-tested.

export class ThumbGate {
  private armed = true;
  private frames = 0;
  private lastThumbs = false;
  private need: number;

  constructor(need = 2) {
    this.need = need;
  }

  /** Consecutive thumb detections counted towards the next release. */
  get streak() { return this.frames; }
  get isArmed() { return this.armed; }

  /**
   * Call once per detection. `thumbs`: Thumb_Up was seen. `ready`: the current bus can take a
   * release right now. Returns true when a release should fire.
   */
  update(thumbs: boolean, ready: boolean): boolean {
    this.lastThumbs = thumbs;
    if (!thumbs) { this.armed = true; this.frames = 0; return false; }
    if (!this.armed) return false;
    this.frames++;
    if (this.frames >= this.need && ready) {
      this.armed = false;
      this.frames = 0;
      return true;
    }
    return false;
  }

  /** A new bus arrived: a thumb still up from the last bus must drop before it counts again. */
  newBus() {
    if (this.lastThumbs) { this.armed = false; this.frames = 0; }
  }

  /** The hand left the frame. */
  lost() {
    this.lastThumbs = false;
    this.armed = true;
    this.frames = 0;
  }
}
