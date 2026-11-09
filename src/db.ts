// Neon (PostgreSQL) холболт. Worker-т хүсэлт бүрд шинэ client, хариу илгээсний дараа хаана.
// Production дээр Hyperdrive binding (HYPERDRIVE) байвал түүгээр (connection pooling), үгүй бол DATABASE_URL-аар шууд.
import postgres from 'postgres';

export type Sql = postgres.Sql;

export function connect(url: string): Sql {
  return postgres(url, {
    max: 1,               // one connection per request (queries are pipelined on it); keeps Neon connection count low
    prepare: false,       // short-lived connections: named prepared statements don't pay off (and break behind PgBouncer)
    fetch_types: false,   // skip the type-lookup round trip; we only use built-in types
    connect_timeout: 10,
    onnotice: () => {},
  });
}

export function databaseUrl(env: { HYPERDRIVE?: { connectionString: string }; DATABASE_URL?: string }) {
  const url = env.HYPERDRIVE?.connectionString || env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL (эсвэл HYPERDRIVE) тохируулаагүй байна');
  return url;
}
