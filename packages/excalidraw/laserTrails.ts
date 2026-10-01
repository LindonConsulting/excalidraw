import { DEFAULT_LASER_COLOR, easeOut } from "@excalidraw/common";

import type { LaserPointerOptions } from "@excalidraw/laser-pointer";

import { AnimatedTrail } from "./animatedTrail";
import { getClientColor } from "./clients";

import type { Trail } from "./animatedTrail";
import type App from "./components/App";
import type { SocketId } from "./types";

/** [ExcalidrawZ] A laser stroke segment relayed to/from the native host. */
export type LaserPointerPathPayload = {
  phase: "start" | "move" | "end";
  /** Scene coordinates. */
  points: [number, number][];
};

export class LaserTrails implements Trail {
  public localTrail: AnimatedTrail;
  private collabTrails = new Map<SocketId, AnimatedTrail>();
  private container?: SVGSVGElement;
  // [ExcalidrawZ] Trail driven by `applyRemotePath` (e.g. the Viewer window
  // mirroring the editor's laser).
  private remoteTrail?: AnimatedTrail;
  // [ExcalidrawZ] Local points not yet relayed to the native host; flushed
  // once per animation frame so bursts coalesce.
  private pendingPoints: [number, number][] = [];
  private pendingFlush: number | null = null;

  constructor(private app: App) {
    this.localTrail = new AnimatedTrail(app, {
      ...this.getTrailOptions(),
      fill: () => DEFAULT_LASER_COLOR,
    });
  }

  private getTrailOptions() {
    return {
      simplify: 0,
      streamline: 0.4,
      sizeMapping: (c) => {
        const DECAY_TIME = 1000;
        const DECAY_LENGTH = 50;
        const t = Math.max(
          0,
          1 - (performance.now() - c.pressure) / DECAY_TIME,
        );
        const l =
          (DECAY_LENGTH -
            Math.min(DECAY_LENGTH, c.totalLength - c.currentIndex)) /
          DECAY_LENGTH;

        return Math.min(easeOut(l), easeOut(t));
      },
    } as Partial<LaserPointerOptions>;
  }

  startPath(x: number, y: number): void {
    this.localTrail.startPath(x, y);
    this.flushLocalPath();
    this.emitLocalPath({ phase: "start", points: [[x, y]] });
  }

  addPointToPath(x: number, y: number): void {
    this.localTrail.addPointToPath(x, y);
    this.queueLocalPoint(x, y);
  }

  endPath(): void {
    if (!this.localTrail.hasCurrentTrail) {
      return;
    }
    this.localTrail.endPath();
    this.flushLocalPath();
    this.emitLocalPath({ phase: "end", points: [] });
  }

  start(container: SVGSVGElement) {
    this.container = container;
    this.localTrail.start(container);
    this.remoteTrail?.start(container);
  }

  stop() {
    this.localTrail.stop();
    this.stopCollabTrails();
    this.remoteTrail?.stop();
    this.remoteTrail = undefined;
    this.container = undefined;
  }

  // [ExcalidrawZ] Relay the local laser stroke to the native host as
  // `laserPointerPath` messages, batched per animation frame.

  private queueLocalPoint(x: number, y: number) {
    this.pendingPoints.push([x, y]);
    if (this.pendingFlush === null) {
      this.pendingFlush = this.app.ownerWindow.requestAnimationFrame(() =>
        this.flushLocalPath(),
      );
    }
  }

  private flushLocalPath() {
    if (this.pendingFlush !== null) {
      this.app.ownerWindow.cancelAnimationFrame(this.pendingFlush);
      this.pendingFlush = null;
    }
    if (this.pendingPoints.length === 0) {
      return;
    }
    const points = this.pendingPoints;
    this.pendingPoints = [];
    this.emitLocalPath({ phase: "move", points });
  }

  private emitLocalPath(payload: LaserPointerPathPayload) {
    (this.app.ownerWindow as any).excalidrawZHelper?.sendMessage?.({
      event: "laserPointerPath",
      data: payload,
    });
  }

  /**
   * [ExcalidrawZ] Draw a laser stroke relayed from another editor (scene
   * coordinates), styled like a collaborator's trail.
   */
  applyRemotePath({ phase, points }: LaserPointerPathPayload) {
    if (!this.container) {
      return;
    }
    if (!this.remoteTrail) {
      this.remoteTrail = new AnimatedTrail(this.app, {
        ...this.getTrailOptions(),
        fill: () => DEFAULT_LASER_COLOR,
      });
      this.remoteTrail.start(this.container);
    }
    const trail = this.remoteTrail;
    let rest = points;
    if (phase === "start" && points.length > 0) {
      trail.startPath(points[0][0], points[0][1]);
      rest = points.slice(1);
    }
    for (const [x, y] of rest) {
      trail.addPointToPath(x, y);
    }
    if (phase === "end") {
      trail.endPath();
    }
  }

  private stopCollabTrails(collaborators?: App["state"]["collaborators"]) {
    for (const [key, trail] of this.collabTrails) {
      const collaborator = collaborators?.get(key);

      if (!collaborator) {
        trail.stop();
        this.collabTrails.delete(key);
      }
    }
  }

  updateCollabTrails(collaborators: App["state"]["collaborators"]) {
    this.stopCollabTrails(collaborators);

    if (!this.container || collaborators.size === 0) {
      return;
    }

    for (const [key, collaborator] of collaborators.entries()) {
      // Current user has their own trail drawn via localTrail
      if (collaborator.isCurrentUser) {
        continue;
      }

      // IDEA: Use the collaborator pointer coordinates to trace out the
      // laser pointer trail when 1) the selected collab tool is the laser
      // pointer and 2) the collab pointer button is in the "down" state.
      let trail = this.collabTrails.get(key);
      if (!trail) {
        trail = new AnimatedTrail(this.app, {
          ...this.getTrailOptions(),
          fill: () =>
            collaborator.pointer?.laserColor ||
            getClientColor(key, collaborator),
        });
        trail.start(this.container);

        this.collabTrails.set(key, trail);
      }

      if (collaborator.pointer && collaborator.pointer.tool === "laser") {
        const buttonDown = collaborator.button === "down";
        const buttonUp = collaborator.button === "up";
        const hasTrail = trail.hasCurrentTrail;

        // Initialize a new trail
        if (buttonDown && !hasTrail) {
          trail.startPath(collaborator.pointer.x, collaborator.pointer.y);
        }

        // Add only original points
        const lastPointOriginal = !trail.hasLastPoint(
          collaborator.pointer.x,
          collaborator.pointer.y,
        );
        if (buttonDown && lastPointOriginal) {
          trail.addPointToPath(collaborator.pointer.x, collaborator.pointer.y);
        }

        // End the trail on button up
        if (buttonUp && hasTrail) {
          trail.addPointToPath(collaborator.pointer.x, collaborator.pointer.y);
          trail.endPath();
        }
      }
    }
  }
}
