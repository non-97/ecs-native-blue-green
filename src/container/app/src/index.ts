import express, { Request, Response, NextFunction } from "express";
import pino from "pino";
import pinoHttp from "pino-http";

const app = express();
const port = Number(process.env.PORT) || 3000;

// Logger
const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.multistream([
    { level: "info", stream: process.stdout },
    { level: "error", stream: process.stderr },
  ])
);

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

app.get("/", (req: Request, res: Response) => {
  res.status(200).json({
    message: "Hello from Express App!",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "OK", timestamp: new Date().toISOString() });
});

app.get("/error", (req: Request, res: Response) => {
  req.log.error("Intentional error endpoint triggered");
  res.status(500).json({ error: "Internal Server Error" });
});

app.get("/crash", (req: Request, res: Response) => {
  req.log.error("Crash endpoint triggered - throwing exception");
  throw new Error("Application crash test - intentional exception");
});

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: "Not Found" });
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  req.log.error({ err }, "Error occurred");
  res.status(500).json({ error: "Internal Server Error" });
});

const server = app.listen(port, "0.0.0.0", () => {
  logger.info({ port }, "Express app listening");
});

process.on("SIGTERM", () => {
  server.close(() => {
    logger.info("SIGTERM signal received: closing HTTP server");
  });
});

process.on("SIGINT", () => {
  server.close(() => {
    logger.info("SIGINT signal received: closing HTTP server");
  });
});
