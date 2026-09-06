/**
 * Code execution engine.
 *
 * Deliberately free of NestJS and Prisma: this runs inside the API today and
 * inside the executor microservice next, and the web app must never pull
 * `node:child_process` into its bundle. Import it from the `./execution`
 * subpath rather than the package root so nothing here reaches the browser.
 */
export * from './semaphore';
export * from './executor';
export * from './trace.types';
export * from './harness';
export * from './compare';
export * from './output';
export * from './jobs';
