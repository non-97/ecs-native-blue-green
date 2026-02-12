import { Pool } from "pg";
import { logger } from "./logger";

const pool: Pool | null = (() => {
  if (!process.env.DB_HOST) return null;

  const p = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || "5432"),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "postgres",
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  p.on("error", (err: Error) => {
    logger.error({ err }, "PostgreSQL pool error");
  });

  return p;
})();

export const getPool = (): Pool | null => pool;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const createTables = async (): Promise<void> => {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS visits (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(255) NOT NULL,
      path VARCHAR(255) NOT NULL,
      user_agent TEXT,
      ip_address VARCHAR(45),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS counter (
      id VARCHAR(50) PRIMARY KEY,
      count INTEGER DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_visits_session_id ON visits(session_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_visits_created_at ON visits(created_at)
  `);
};

export const initializeDatabase = async (
  maxRetries = 30,
  retryIntervalMs = 10000
): Promise<void> => {
  if (!pool) return;

  for (const attempt of Array.from({ length: maxRetries }, (_, i) => i + 1)) {
    try {
      await createTables();
      logger.info("Database tables initialized");
      return;
    } catch (err) {
      logger.error(
        { err, attempt, maxRetries },
        "Failed to initialize database, retrying..."
      );
      if (attempt < maxRetries) {
        await sleep(retryIntervalMs);
      }
    }
  }

  logger.error("Failed to initialize database tables after all retries");
};

export const closePool = async (): Promise<void> => {
  if (pool) {
    await pool.end();
    logger.info("PostgreSQL pool closed");
  }
};
