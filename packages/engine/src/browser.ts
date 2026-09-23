/**
 * Browser-safe entry: review + explain only. The package root re-exports the KataGo client, which
 * spawns child processes, so importing it from the web app would break the bundle.
 */
export * from './review.ts';
export * from './explain.ts';
