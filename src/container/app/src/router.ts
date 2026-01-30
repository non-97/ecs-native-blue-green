import { Router, Request, Response } from "express";
import { getPool } from "./lib/db";
import { getValkey } from "./lib/cache";

// ECSタスクIDを取得
const getTaskId = async (): Promise<string> => {
  const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!metadataUri) return "unknown";

  try {
    const response = await fetch(`${metadataUri}/task`);
    const metadata = (await response.json()) as { TaskARN?: string };
    const taskArn = metadata.TaskARN || "";
    return taskArn.split("/").pop() || "unknown";
  } catch {
    return "unknown";
  }
};

// セッション型拡張
declare module "express-session" {
  interface SessionData {
    views: number;
    firstVisit: string;
    lastVisit: string;
  }
}

export const router = Router();

// メインエンドポイント: セッション情報 + DB訪問履歴
router.get("/", async (req: Request, res: Response) => {
  const pool = getPool();
  const valkey = getValkey();

  try {
    // セッション初期化（Valkeyが有効な場合）
    if (req.session && valkey) {
      if (!req.session.views) {
        req.session.views = 0;
        req.session.firstVisit = new Date().toISOString();
      }
      req.session.views++;
      req.session.lastVisit = new Date().toISOString();
    }

    // DBに訪問履歴を記録（poolが設定されている場合）
    let visit: { id: number } | null = null;
    let counter: { count: number } | null = null;
    let sessionVisits: Array<{ id: number; path: string; created_at: Date }> =
      [];

    if (pool) {
      const visitResult = await pool.query(
        `INSERT INTO visits (session_id, path, user_agent, ip_address)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [
          req.sessionID || "no-session",
          req.path,
          req.headers["user-agent"] || null,
          req.ip || null,
        ]
      );
      visit = { id: visitResult.rows[0].id };

      const counterResult = await pool.query(
        `INSERT INTO counter (id, count) VALUES ('global', 1)
         ON CONFLICT (id) DO UPDATE SET count = counter.count + 1
         RETURNING count`,
        []
      );
      counter = { count: counterResult.rows[0].count };

      const visitsResult = await pool.query(
        `SELECT id, path, created_at FROM visits
         WHERE session_id = $1 ORDER BY created_at DESC LIMIT 5`,
        [req.sessionID || "no-session"]
      );
      sessionVisits = visitsResult.rows;
    }

    res.status(200).json({
      message: "Hello from Express App with Session!",
      version: "2.0.0",
      timestamp: new Date().toISOString(),
      taskId: await getTaskId(),
      session: req.session
        ? {
            sessionId: req.sessionID,
            views: req.session.views,
            firstVisit: req.session.firstVisit,
            lastVisit: req.session.lastVisit,
          }
        : null,
      database: counter
        ? {
            totalSiteVisits: counter.count,
            currentVisitId: visit?.id,
            recentVisits: sessionVisits.map((v) => ({
              id: v.id,
              path: v.path,
              createdAt: v.created_at,
            })),
          }
        : null,
    });
  } catch (error) {
    req.log.error({ error }, "Error in main endpoint");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// セッションリセット
router.post("/session/reset", async (req: Request, res: Response) => {
  const pool = getPool();

  try {
    const sessionId = req.sessionID;

    if (pool) {
      await pool.query(`DELETE FROM visits WHERE session_id = $1`, [sessionId]);
    }

    if (req.session) {
      req.session.destroy((err) => {
        if (err) {
          req.log.error({ err }, "Failed to destroy session");
          return res.status(500).json({ error: "Failed to reset session" });
        }
        res.json({
          message: "Session reset successfully",
          deletedSessionId: sessionId,
        });
      });
    } else {
      res.json({ message: "No session to reset" });
    }
  } catch (error) {
    req.log.error({ error }, "Error resetting session");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// DB統計情報取得
router.get("/stats", async (req: Request, res: Response) => {
  const pool = getPool();

  try {
    if (!pool) {
      return res.status(503).json({ error: "Database not configured" });
    }

    const [counterResult, totalVisitsResult, uniqueSessionsResult] =
      await Promise.all([
        pool.query(`SELECT count FROM counter WHERE id = 'global'`),
        pool.query(`SELECT COUNT(*) as count FROM visits`),
        pool.query(`SELECT COUNT(DISTINCT session_id) as count FROM visits`),
      ]);

    res.json({
      totalPageViews: counterResult.rows[0]?.count || 0,
      totalVisitRecords: parseInt(totalVisitsResult.rows[0].count),
      uniqueSessions: parseInt(uniqueSessionsResult.rows[0].count),
    });
  } catch (error) {
    req.log.error({ error }, "Error fetching stats");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ヘルスチェック（DB/Cache接続確認）
router.get("/health", async (req: Request, res: Response) => {
  const pool = getPool();
  const valkey = getValkey();

  const health: {
    status: string;
    db?: string;
    cache?: string;
    error?: string;
  } = { status: "healthy" };

  try {
    if (pool) {
      await pool.query("SELECT 1");
      health.db = "connected";
    } else {
      health.db = "not configured";
    }

    if (valkey) {
      await valkey.ping();
      health.cache = "connected";
    } else {
      health.cache = "not configured";
    }

    res.json(health);
  } catch (error) {
    health.status = "unhealthy";
    health.error = error instanceof Error ? error.message : "Unknown error";
    res.status(503).json(health);
  }
});

// エラーテスト用エンドポイント
router.get("/error", (req: Request, res: Response) => {
  req.log.error("Intentional error endpoint triggered");
  res.status(500).json({ error: "Internal Server Error" });
});

router.get("/crash", (req: Request, res: Response) => {
  req.log.error("Crash endpoint triggered - throwing exception");
  throw new Error("Application crash test - intentional exception");
});

router.get("/large-log", (req: Request, res: Response) => {
  const largeData = {
    message: "Testing 16KB+ log handling",
    timestamp: new Date().toISOString(),
    data: "X".repeat(20000),
  };

  req.log.error(largeData, "Large log entry generated");

  res.status(200).json({
    message: "Large log generated successfully",
    logSize: JSON.stringify(largeData).length,
    timestamp: new Date().toISOString(),
  });
});
