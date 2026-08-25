import type { CachePort } from "../../ports/cache.port.js";

/** First release ships without caching. Jira stays the single source of truth. */
export class NoopCache implements CachePort {
  async get<T>(): Promise<T | undefined> {
    return undefined;
  }

  async set(): Promise<void> {
    // intentionally empty
  }

  async invalidate(): Promise<void> {
    // intentionally empty
  }
}
