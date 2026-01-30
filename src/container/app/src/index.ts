import express, { Request, Response, NextFunction } from "express";
import session from "express-session";
import { RedisStore } from "connect-redis";
import pinoHttp from "pino-http";

import { logger } from "./lib/logger";
import { initializeDatabase, closePool } from "./lib/db";
import { getValkey, closeValkey } from "./lib/cache";
import { router } from "./router";

const app = express();
const port = Number(process.env.PORT) || 3000;

// HTTPロギング
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url === "/health",
    },
    customLogLevel: (req, res, err) => {
      if (res.statusCode >= 500 || err) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
  })
);

app.use(express.json());

// セッション設定（Valkeyが利用可能な場合のみ）
const valkey = getValkey();
if (valkey) {
  app.use(
    session({
      store: new RedisStore({ client: valkey }),
      secret:
        process.env.SESSION_SECRET || "your-secret-key-change-in-production",
      resave: false,
      saveUninitialized: true,
      cookie: {
        secure: false,
        maxAge: 1000 * 60 * 60 * 24, // 24時間
      },
    })
  );
}

// ルート
app.use(router);

// 404ハンドラー
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: "Not Found" });
});

// エラーハンドラー
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  req.log.error({ err }, "Error occurred");
  res.status(500).json({ error: "Internal Server Error" });
});

// サーバー起動
const startServer = async () => {
  await initializeDatabase();

  const server = app.listen(port, "0.0.0.0", () => {
    logger.info({ port }, "Express app listening");
  });

  const shutdown = async () => {
    logger.info("Shutting down...");

    server.close(async () => {
      logger.info("HTTP server closed");
      await closePool();
      closeValkey();
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

startServer().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
