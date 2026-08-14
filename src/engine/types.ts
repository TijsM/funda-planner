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
  /** 'a' | 'b' for 'end' */
  key?: 'a' | 'b';
}

export type Draft =
  | { kind: 'wall'; pts: Pt[]; t: number; cur?: Pt }
  | { kind: 'room'; pts: Pt[]; cur?: Pt }
  | { kind: 'measure'; a: Pt; cur?: Pt; b?: Pt }
  | { kind: 'cal'; a?: Pt; b?: Pt; cur?: Pt };

export interface Marquee { x0: number; y0: number; x1: number; y1: number }
