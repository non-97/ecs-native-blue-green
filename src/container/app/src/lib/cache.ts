import Redis from "ioredis";
import { logger } from "./logger";

const valkey: Redis | null = (() => {
  if (!process.env.VALKEY_HOST) return null;

  const v = new Redis({
    host: process.env.VALKEY_HOST,
    port: parseInt(process.env.VALKEY_PORT || "6379"),
    tls: process.env.VALKEY_TLS === "true" ? {} : undefined,
    retryStrategy: (times) => {
      if (times > 3) {
        logger.error("Valkey connection failed after 3 retries");
        return null;
      }
      return Math.min(times * 100, 3000);
    },
  });

  v.on("error", (err) => {
    logger.error({ err }, "Valkey connection error");
  });

  v.on("connect", () => {
    logger.info("Connected to Valkey");
  });

  return v;
})();

export const getValkey = (): Redis | null => valkey;

export const closeValkey = (): void => {
  if (valkey) {
    valkey.disconnect();
    logger.info("Valkey disconnected");
  }
};
