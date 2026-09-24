// @astrojs/cloudflare v13 (Astro 6): Runtime is `{ cfContext: ExecutionContext }` and is not generic.
// Bindings are accessed via `import { env } from 'cloudflare:workers'`, not via locals.
type Runtime = import("@astrojs/cloudflare").Runtime;

declare namespace App {
	interface Locals extends Runtime {}
}
