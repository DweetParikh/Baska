import Redis from "ioredis";

export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSecs: number): Promise<void>;
  del(key: string): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
  readonly kind: "redis" | "memory";
}

export class MemoryCache implements Cache {
  readonly kind = "memory" as const;
  private m = new Map<string, { v: string; exp: number }>();
  async get(key: string) {
    const e = this.m.get(key);
    if (!e) return null;
    if (e.exp < Date.now()) {
      this.m.delete(key);
      return null;
    }
    return e.v;
  }
  async set(key: string, value: string, ttlSecs: number) {
    this.m.set(key, { v: value, exp: Date.now() + ttlSecs * 1000 });
  }
  async del(key: string) {
    this.m.delete(key);
  }
  async ping() {
    return true;
  }
  async close() {
    this.m.clear();
  }
}

export class RedisCache implements Cache {
  readonly kind = "redis" as const;
  private r: Redis;
  constructor(url: string, private prefix = "baska:") {
    this.r = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
    // A broken cache must degrade to slower reads, never crash the API.
    this.r.on("error", () => {});
  }
  async get(key: string) {
    try {
      return await this.r.get(this.prefix + key);
    } catch {
      return null;
    }
  }
  async set(key: string, value: string, ttlSecs: number) {
    try {
      await this.r.set(this.prefix + key, value, "EX", ttlSecs);
    } catch {
      /* ignore */
    }
  }
  async del(key: string) {
    try {
      await this.r.del(this.prefix + key);
    } catch {
      /* ignore */
    }
  }
  async ping() {
    try {
      return (await this.r.ping()) === "PONG";
    } catch {
      return false;
    }
  }
  async close() {
    this.r.disconnect();
  }
}

export function createCache(redisUrl?: string): Cache {
  return redisUrl ? new RedisCache(redisUrl) : new MemoryCache();
}
