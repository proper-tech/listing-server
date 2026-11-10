import type { Db } from "./db/index.ts";
import type { PublicAgent } from "./db/schema.ts";

export type AppEnv = {
  Bindings: Env;
  Variables: {
    db: Db;
    agent: PublicAgent | null; // loadAuth (JWT) тавина; нэвтрээгүй бол null
  };
};
