import pino from "pino";

export const logger = pino(
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
