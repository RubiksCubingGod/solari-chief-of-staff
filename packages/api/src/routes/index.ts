import type { FastifyInstance } from 'fastify';

import { registerAuthRoutes } from './auth.js';
import { registerBindingCodeRoutes } from './binding-codes.js';
import { registerCalendarItemRoutes } from './calendar-items.js';
import { registerObservationRoutes } from './observations.js';
import { registerTaskRoutes } from './tasks.js';
import { registerWatchRoutes } from './watches.js';

/**
 * Every engine-free CRUD route the chat tools and the dashboard consume. They
 * are registered directly on the root instance rather than as encapsulated
 * plugins: there is nothing to encapsulate yet, and a flat list keeps the whole
 * HTTP surface readable in one file.
 */
export function registerRoutes(app: FastifyInstance): void {
  // First, because it is the door every other route below is behind: nothing
  // here is reachable without the session it issues.
  registerAuthRoutes(app);
  registerBindingCodeRoutes(app);
  registerWatchRoutes(app);
  registerObservationRoutes(app);
  registerCalendarItemRoutes(app);
  registerTaskRoutes(app);
}
