/** The editor engine: pure TypeScript, no React, no DOM, no network.
 *  Runs unchanged in the browser, in Node (tests), and under node-canvas
 *  on a server — see docs/ARCHITECTURE.md. */
export * from './types';
export * from './geometry';
export * from './shapes';
export * from './catalog';
export * from './model';
export * from './view';
export * from './hit';
export * from './render';
export * from './prompt';
export * from './io/funda';
export * from './io/serialize';
