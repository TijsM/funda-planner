/** The metric surface score.mjs imports. Every entry is a pure function over
 *  decoded pixels and the ground-truth sidecar; the only impure things here are
 *  loadPixels, which reads a PNG, and the OCR worker behind textPixelFraction.
 *
 *  ORDER MATTERS AT THE CALL SITE: envelopeIou recovers the transform, and
 *  roomIou and lineF1 both take it. Do not let them register again — three
 *  metrics that disagree about where the building is cannot be compared.
 *
 *  Object counting is deliberately absent. Doing it honestly needs an
 *  open-vocabulary detector, and a heuristic ("count the dark blobs near the
 *  table") would be believed by everyone who read the scorecard and would be
 *  wrong. The gap is real and stays visible.
 */

export { loadPixels, toPng, grey, greyToPixels, downscaleGrey, sobel, thinEdges } from './pixels.mjs';
export {
  IDENTITY, countMask, deepestPoint, distanceTransform, downscaleMask, fillPoly, floodFill,
  iouOfMasks, largestComponent, mapPoly, moments, newMask, strokeLine, strokePoly,
} from './mask.mjs';
export { textPixelFraction, closeTextWorker } from './text.mjs';
export { envelopeIou, envelopeMask, footprintMask, registerMasks } from './envelope.mjs';
export { roomIou } from './rooms.mjs';
export { lineF1, wallRaster } from './lines.mjs';
export { orthoScore } from './ortho.mjs';
export { phash, phashDistance } from './phash.mjs';
