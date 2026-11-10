import type { Db } from "./db/index.ts";

export type AppEnv = { Bindings: Env; Variables: { db: Db } };
