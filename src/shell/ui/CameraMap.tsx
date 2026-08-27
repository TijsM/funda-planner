'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Floor, Pt } from '@engine/types';
import {
  camInside, camRoom, normaliseCam, sightLine, sightPolygon, type Cam,
} from '@engine/camera';
import { planFrame, type FrameOpts } from '@engine/frame';
import { toScreen, toWorld } from '@engine/view';
import { renderFloorCanvas } from '../files';

/** Where the camera stands, on a small plan of the floor.
 *
 *  Placing a camera is a spatial question and this is the only spatial answer:
 *  three number fields would let somebody set x = 640, y = 210 and find out what
 *  that means by spending a credit. So the plan is drawn small, the camera is a
 *  dot on it, and what it can see is a cone.
 *
 *  It draws the same picture `paint()` draws on the main canvas, through the
 *  same `renderFloorCanvas` the reference image comes out of, because a minimap
 *  with its own opinion of what the plan looks like is a second renderer to keep
 *  in step. */

/** The map's longest side, in CSS pixels. Small enough to sit above the prompt
 *  box without pushing the panel's real work off the screen, big enough that a
 *  4 m room is 60 px across and a camera can be put in a corner of it. */
const MAP_PX = 268;

/** How far from the dot the aim handle sits, in screen pixels. Fixed rather than
 *  scaled off the sight line: a handle that moved with the room would be under
 *  the dot in a cupboard and off the map in a barn, and it is a grip, not a
 *  measurement. */
const AIM_PX = 52;

/** Grab radius. Generous, because both grips are small and the cost of missing
 *  one is that the camera teleports to wherever the pointer was. */
const GRAB_PX = 13;

type Drag = 'move' | 'aim' | null;

export interface CameraMapProps {
  floor: Floor;
  cam: Cam;
  onChange: (c: Cam) => void;
}

export function CameraMap({ floor, cam, onChange }: CameraMapProps) {
  const host = useRef<HTMLCanvasElement | null>(null);
  const plan = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<Drag>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  /* One options object, handed both to the thing that draws the plan and to the
     frame the pointer maths reads. `planFrame` is pure, so the two agree by
     construction — and a map whose cone is placed by a different frame from the
     one that drew the walls is a cone pointing at the wrong room. */
  const frameOpts: FrameOpts = { clean: true, maxPx: MAP_PX };
  const frame = planFrame(floor, frameOpts);

  /* The plan bitmap, redrawn only when the plan does. Everything the pointer
     does moves the cone, and re-rasterising 183 walls per pointermove is what
     makes a drag feel broken. */
  useEffect(() => {
    const cv = renderFloorCanvas(floor, { ...frameOpts, furniture: true, roomLabels: false });
    plan.current = cv;
    setSize(cv ? { w: cv.width, h: cv.height } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floor]);

  const draw = useCallback(() => {
    const cv = host.current, src = plan.current;
    if (!cv || !src || !frame) return;
    const g = cv.getContext('2d');
    if (!g) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    if (cv.width !== Math.round(src.width * dpr)) {
      cv.width = Math.round(src.width * dpr);
      cv.height = Math.round(src.height * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, src.width, src.height);
    g.drawImage(src, 0, 0, src.width, src.height);

    const at = toScreen(frame.view, cam.x, cam.y);
    const rad = (cam.yaw * Math.PI) / 180;
    /* The region the camera can actually see, traced ray by ray and stopped at
       the first wall — not a circular wedge. A wedge ran through the masonry and
       out the other side, and what it laid over two rooms away is exactly what
       the brief was listing. The picture of the shot and the test for what is in
       it are the same answer now; `sightPolygon` is where that lives. */
    const seen = sightPolygon(floor, cam).map(p => toScreen(frame.view, p.x, p.y));
    g.beginPath();
    seen.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    g.fillStyle = 'rgba(228,99,44,0.22)';
    g.fill();
    g.strokeStyle = 'rgba(228,99,44,0.75)';
    g.lineWidth = 1;
    g.stroke();

    /* the aim handle, on the axis of the cone */
    const tip = { x: at.x + Math.cos(rad) * AIM_PX, y: at.y + Math.sin(rad) * AIM_PX };
    g.beginPath();
    g.moveTo(at.x, at.y);
    g.lineTo(tip.x, tip.y);
    g.strokeStyle = 'rgba(228,99,44,0.9)';
    g.stroke();
    for (const [p, r, fill] of [[tip, 4, '#E4632C'], [at, 5.5, '#E4632C']] as const) {
      g.beginPath();
      g.arc(p.x, p.y, r, 0, Math.PI * 2);
      g.fillStyle = fill;
      g.fill();
      g.strokeStyle = '#17140F';
      g.lineWidth = 1.5;
      g.stroke();
    }
  }, [cam, floor, frame]);

  useEffect(draw, [draw, size]);

  const pointAt = (e: React.PointerEvent<HTMLCanvasElement>): Pt => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!frame) return;
    const p = pointAt(e);
    const at = toScreen(frame.view, cam.x, cam.y);
    const rad = (cam.yaw * Math.PI) / 180;
    const tip = { x: at.x + Math.cos(rad) * AIM_PX, y: at.y + Math.sin(rad) * AIM_PX };
    /* The aim handle wins the tie. It sits on top of the cone and, on a camera
       pushed into a corner, within a few pixels of the dot itself — and the
       cheaper mistake is rotating when you meant to move.
       Everything else is a move, including a click on bare plan: aiming is the
       handle's job, and somebody dragging a camera two metres down the room is
       not asking to have it spun round on the way. */
    drag.current = Math.hypot(p.x - tip.x, p.y - tip.y) < GRAB_PX ? 'aim' : 'move';
    e.currentTarget.setPointerCapture(e.pointerId);
    onMove(e);
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current || !frame) return;
    const p = pointAt(e);
    if (drag.current === 'aim') {
      const at = toScreen(frame.view, cam.x, cam.y);
      const yaw = (Math.atan2(p.y - at.y, p.x - at.x) * 180) / Math.PI;
      onChange(normaliseCam({ ...cam, yaw }));
    } else {
      const w = toWorld(frame.view, p.x, p.y);
      onChange(normaliseCam({ ...cam, x: Math.round(w.x), y: Math.round(w.y) }));
    }
  };

  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  if (!frame || !size) return null;

  return (
    <canvas
      ref={host}
      id="aiCamMap"
      className="cam-map"
      style={{ width: size.w, height: size.h }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    />
  );
}

/** What the camera is looking at, said in words under the map — the two things
 *  that decide whether a viewpoint is worth spending a credit on, and neither is
 *  legible from a cone on a 268 px plan.
 *
 *  A camera outside the walls is the loud failure: it renders the back of the
 *  building, and nothing about the picture says why. A very short sight line is
 *  the quiet one — a technically valid shot of the plaster 80 cm in front of the
 *  lens, which is what happens when a camera is dropped in a hall. */
export function cameraNote(floor: Floor, cam: Cam): { text: string; bad: boolean } {
  if (!camInside(floor, cam)) {
    return { text: 'The camera is outside the building — it will render the wall from the garden.', bad: true };
  }
  const room = camRoom(floor, cam);
  const reach = sightLine(floor, cam);
  const where = room ? `In the ${room.name.toLowerCase()}` : 'Inside the walls, in no drawn room';
  if (Number.isFinite(reach) && reach < 150) {
    return {
      text: `${where}, but only ${Math.round(reach)} cm of clear view — the wall will fill the frame.`,
      bad: true,
    };
  }
  const far = Number.isFinite(reach) ? `${(reach / 100).toFixed(1)} m to the far wall` : 'no wall in front of it';
  return { text: `${where}, ${cam.z} cm up, ${far}.`, bad: false };
}
