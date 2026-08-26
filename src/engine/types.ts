/** The document model. Every length is centimetres; y grows downward, which is
 *  what Floorplanner's .fml uses, so imported geometry needs no flipping. */

export interface Pt { x: number; y: number }
export interface BBox { x0: number; y0: number; x1: number; y1: number }

export type OpeningKind = 'door' | 'window';

export interface Opening {
  id: string;
  /** position along the wall, 0..1 from `a` to `b` */
  at: number;
  type: OpeningKind;
  width: number;
  /** hinge at the far jamb */
  flip?: 0 | 1;
  /** swings to the other side */
  side?: 0 | 1;
}

export interface Wall { id: string; a: Pt; b: Pt; t: number; openings: Opening[] }

export interface Area {
  id: string;
  poly: Pt[];
  name: string;
  color: string;
  /** free text the user wrote about this room; feeds the image-generator prompt.
   *  Absent by default — never invented from the catalogue or the listing. */
  desc?: string;
  /** label offset from the centroid */
  nx: number; ny: number;
  label: boolean;
}

/** An object a person drew for themselves, because the catalogue did not have it.
 *
 *  The outline is in UNIT space — every point 0..1 on both axes — so one drawing
 *  serves every size the thing is ever stretched to, and a shape drawn on a 90 cm
 *  square still reads right at 3 m. Unused space around the ink is cropped: the
 *  unit square is the drawing's own bounds, not the authoring canvas it was
 *  clicked on. `round` is a flag rather than forty points because a polygon
 *  approximating an ellipse looks like a polygon at print size. */
export interface Shape {
  /** doubles as the item's `kind`, prefixed so it can never collide with a
   *  catalogue kind — see CUSTOM_PREFIX in `custom.ts` */
  id: string;
  name: string;
  /** the footprint it is placed at, in centimetres */
  w: number; h: number;
  poly?: Pt[];
  round?: 1;
  /** centimetres above the floor. Only the depth control map reads it, and it is
   *  the one number a person cannot infer from a top-down drawing. */
  z?: number;
}

export interface Item {
  id: string;
  kind: string;
  x: number; y: number;
  w: number; h: number;
  rot: number;
  color?: string;
  label?: string;
  /** free text the user wrote about this object; feeds the image-generator
   *  prompt. Absent by default — never seeded from the catalogue. */
  desc?: string;
  /** the label was deliberately cleared — do not fall back to the catalogue name */
  noLabel?: 1;
  flip?: 0 | 1;
  /** a fitted object imported from the listing, not something the user placed */
  fromFunda?: 1;
  /** For a custom object, the drawing itself — copied onto the item at placement
   *  rather than looked up from the project's list.
   *
   *  Inlined on purpose. A lookup is one more thing that can be missing: a plan
   *  mailed to someone, a shape deleted from the tray, a floor pasted into
   *  another project would each leave an object nobody can draw, and the renderer
   *  would fall back to a plain block without saying why. The bytes are a dozen
   *  points; the alternative is a plan that renders differently depending on what
   *  else is open. */
  shape?: Shape;
}

export interface Note { id: string; x: number; y: number; text: string; size: number; rot: number; color: string }
export interface Dim { id: string; a: Pt; b: Pt }
export interface Line { id: string; a: Pt; b: Pt; t?: number; arrow?: 1; color?: string }

export interface RefImage { src: string; x: number; y: number; w: number; h: number }

export interface Floor {
  id: string;
  name: string;
  level: number;
  walls: Wall[];
  areas: Area[];
  items: Item[];
  notes: Note[];
  dims: Dim[];
  lines: Line[];
  ref: RefImage | null;
  /** reference bitmap advertised by the listing, resolved lazily */
  refUrl?: string | null;
  fmlDesignId?: number;
}

export interface ProjectSource {
  url: string | null;
  address: string | null;
  title: string | null;
  projectId: number | null;
  fetchedAt: number;
}

export interface Project {
  schema: number;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  source: ProjectSource | null;
  floors: Floor[];
  /** the custom objects drawn in this plan, which is what the tray offers back.
   *  Placed items carry their own copy, so deleting one here never breaks a floor
   *  that already uses it. */
  shapes?: Shape[];
}

/* ── things the renderer and hit-testing need, but the document does not ── */

export type ObjKind = 'wall' | 'area' | 'item' | 'note' | 'dim' | 'line' | 'opening';
export interface SelRef { t: ObjKind; id: string }

/** resolved selection entry — `wall` is the parent wall when t === 'opening' */
export type SelObj =
  | { t: 'wall'; o: Wall } | { t: 'area'; o: Area } | { t: 'item'; o: Item }
  | { t: 'note'; o: Note } | { t: 'dim'; o: Dim } | { t: 'line'; o: Line }
  | { t: 'opening'; o: Opening; wall: Wall };

export type Hit = SelObj;

/** pan/zoom, in screen pixels per centimetre */
export interface View { zoom: number; px: number; py: number }

export interface Layers { rooms: boolean; areas: boolean; furn: boolean; dims: boolean; notes: boolean }

export type HandleKind = 'res' | 'rot' | 'end' | 'vtx';
export interface Handle {
  k: HandleKind;
  /** screen coordinates */
  sx: number; sy: number;
  t: ObjKind;
  o: Item | Wall | Dim | Line | Area;
  /** corner index for 'res', vertex index for 'vtx' */
  i?: number;
  /** which way a 'res' handle pulls, in the object's own unrotated frame: ±1 on
   *  both axes is a corner, a 0 on one axis is a side and leaves that axis
   *  alone. The drag reads this rather than looking the index back up. */
  dir?: readonly [number, number];
  /** 'a' | 'b' for 'end' */
  key?: 'a' | 'b';
}

export type Draft =
  | { kind: 'wall'; pts: Pt[]; t: number; cur?: Pt }
  | { kind: 'room'; pts: Pt[]; cur?: Pt }
  | { kind: 'measure'; a: Pt; cur?: Pt; b?: Pt }
  | { kind: 'cal'; a?: Pt; b?: Pt; cur?: Pt };

export interface Marquee { x0: number; y0: number; x1: number; y1: number }
