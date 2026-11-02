import { Worker } from "node:worker_threads";

/**
 * 目录库客户端（主线程侧）。
 *
 * 契约（与参考项目 channel-hub 的账本客户端同口径）：
 * - 单次调用超时（默认 5s）只**拒绝这一次调用**并计入 `failedWrites`，
 *   绝不阻塞或中断调用方；存储是旁路，浏览与管理不能因为它失败而停下。
 * - worker 崩了就丢弃在途请求并把错误交给各自的 Promise，下次调用重新拉起。
 * - `close()` 后所有调用立即失败，供宿主停用插件 / 热重载时收尾。
 */
export interface CatalogStoreOptions {
  workerPath: string;
  dbPath: string;
  timeoutMs?: number;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CatalogStore {
  #worker: Worker | null = null;
  #pending = new Map<number, Pending>();
  #seq = 0;
  #closed = false;
  /** 超时或 worker 失败的累计次数，供界面标注「存储异常」而不谎报成功。 */
  failedWrites = 0;

  constructor(private options: CatalogStoreOptions) {}

  get closed(): boolean {
    return this.#closed;
  }

  #start(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(this.options.workerPath, {
      workerData: { dbPath: this.options.dbPath },
    });
    worker.on("message", (message: any) => {
      const entry = this.#pending.get(message?.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.#pending.delete(message.id);
      if (message.ok) entry.resolve(message.value);
      else entry.reject(Error(String(message.message)));
    });
    worker.on("error", (error) => this.#fail(error));
    worker.on("exit", () => {
      this.#worker = null;
      if (!this.#closed) this.#fail(Error("catalog worker exited"));
    });
    // 让 worker 不阻止进程退出：宿主关闭时由 close() 显式收尾。
    worker.unref();
    this.#worker = worker;
    return worker;
  }

  #fail(error: Error): void {
    this.failedWrites += 1;
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
  }

  call<T = any>(method: string, payload: any = {}): Promise<T> {
    if (this.#closed)
      return Promise.reject(Error("catalog store is closed"));
    const worker = this.#start();
    const id = ++this.#seq;
    const timeoutMs = this.options.timeoutMs ?? 5000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.failedWrites += 1;
        reject(Error("catalog store call timed out: " + method));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, method, payload });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const worker = this.#worker;
    this.#worker = null;
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(Error("catalog store is closed"));
    }
    this.#pending.clear();
    if (worker) await worker.terminate();
  }
}