/**
 * 目录库工作线程（消息适配层）。
 *
 * ⚠️ 为什么必须是独立线程：单分片 626KB / 617 条、全量 19,866 条 ≈19.2MB。
 * 解析（`JSON.parse` + 归一化）与写库若占住宿主主线程，滚动与流式输出都会卡。
 * 因此主线程只做网络与进度，**分片正文原样送进来，解析与写库都在这里**；
 * 主线程只收计数与错误。
 *
 * 真正的 SQL 在 `catalog-db.ts`（纯句柄、可离线用 `:memory:` 测），这里只做
 * 消息分发：任何异常都收敛成 `{ok:false,message}`，不让线程崩掉。
 */
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { CatalogDb } from "./catalog-db.ts";
import type { CatalogQuery, ChunkRef } from "../core/types.ts";

interface WorkerRequest {
  id: number;
  method: string;
  payload: any;
}

let catalog: CatalogDb | null = null;

function open(path: string): CatalogDb {
  if (catalog) return catalog;
  /**
   * ⚠️ 必须先建目录再开库：全新 profile 或首次启用本插件时数据目录并不存在，
   * `new DatabaseSync()` 会直接失败（真实宿主契约测试抓到：`status` 因此回
   * `plugin-harbor/error`，界面显示不出任何读数）。这里只创建**本插件自己的**
   * 数据目录，不触碰 profile 的清单与 patch。
   */
  mkdirSync(dirname(path), { recursive: true });
  catalog = new CatalogDb(path);
  return catalog;
}

/** 取出本次调用要用的库句柄（`ping` 用 payload 里的路径，其余用 workerData）。 */
function handle(path: string, method: string, payload: any): unknown {
  if (method === "ping") {
    const db = open(String(payload?.path ?? path));
    return { path: String(payload?.path ?? path), ...db.meta };
  }
  const db = open(path);
  switch (method) {
    case "catalog.applyChunk": {
      const chunk = payload?.chunk as ChunkRef;
      if (!chunk?.url) throw Error("applyChunk 缺少 chunk.url");
      return { rows: db.applyChunk(chunk, String(payload.body ?? "")) };
    }
    case "catalog.removeChunks":
      return { removed: db.removeChunks(Array.isArray(payload?.urls) ? payload.urls : []) };
    case "catalog.applyCurated":
      return db.applyCurated(String(payload?.body ?? ""));
    case "catalog.setSyncState":
      db.setSyncState(payload?.state ?? {});
      return { ok: true };
    case "catalog.knownChunks":
      return { chunks: [...db.knownChunks(payload?.lang).entries()] };
    case "catalog.counts":
      return db.counts(payload?.lang);
    case "catalog.list":
      return db.list((payload?.query ?? {}) as CatalogQuery);
    case "catalog.rowsByRepo": {
      const repos: string[] = Array.isArray(payload?.repos) ? payload.repos : [];
      return { rows: [...db.rowsByRepo(repos).values()] };
    }
    case "catalog.putDetail":
      db.putDetail(String(payload?.repo ?? ""), payload?.record ?? null);
      return { ok: true };
    case "catalog.getDetails": {
      const repos: string[] = Array.isArray(payload?.repos) ? payload.repos : [];
      return { details: [...db.getDetails(repos).entries()] };
    }
    case "installed.putChecks": {
      const checks = Array.isArray(payload?.checks) ? payload.checks : [];
      return { written: db.putChecks(checks) };
    }
    case "installed.getChecks":
      return { checks: [...db.getChecks().values()] };
    case "op.putOp":
      db.putOp(payload?.task);
      return { ok: true };
    case "op.listOps":
      return { tasks: db.listOps(Number(payload?.limit ?? 50)) };
    case "close":
      db.close();
      catalog = null;
      return { closed: true };
    default:
      throw Error("Unknown catalog store method: " + method);
  }
}

const dbPath = String(workerData?.dbPath ?? "");

parentPort?.on("message", (request: WorkerRequest) => {
  try {
    parentPort?.postMessage({
      id: request.id,
      ok: true,
      value: handle(dbPath, request.method, request.payload),
    });
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});