/**
 * graph-memory-pro v2.1.2 — Neo4j Mock 测试基础设施
 *
 * 提供：
 *   - mockDriver(): 模拟 neo4j-driver 的 Driver 接口
 *   - mockSession(): 模拟 Session，记录所有 Cypher 查询与参数
 *   - mockResult(): 模拟 Neo4j Result（records 支持 .get()）
 *
 * 设计目标：
 *   - 不依赖真实 Neo4j 实例（CI 友好）
 *   - 允许测试断言"调用了什么 Cypher + 参数"
 *   - 允许测试预置返回数据
 *
 * 使用示例：
 *   const driver = mockDriver();
 *   driver.session.mockReturnValue(mockSession([{ a: 1 }]));
 *   await upsertNode(driver, { id: "n1", ... });
 *   expect(driver.session().runCalls[0].query).toContain("MERGE");
 */

// ── Neo4j Integer 模拟 ──────────────────────────────────────

export class MockInteger {
  constructor(private value: number) {}
  toNumber(): number { return this.value; }
  toString(): string { return String(this.value); }
}

/** 将普通对象包装为支持 .toNumber() 的 record */
export function mockRecord(fields: Record<string, any>): any {
  return {
    get(key: string): any {
      const v = fields[key];
      if (v == null) return null;
      if (typeof v === "number") return new MockInteger(v);
      if (Array.isArray(v)) return v.map(item => typeof item === "object" && item ? mockRecord(item) : item);
      if (typeof v === "object") return mockRecord(v);
      return v;
    },
    has(key: string): boolean { return key in fields; },
    keys: () => Object.keys(fields),
  };
}

export interface CypherCall {
  query: string;
  params: Record<string, any>;
}

export interface MockSession {
  /** 调用 session.run() 的记录 */
  runCalls: CypherCall[];
  /** 调用 session.close() 次数 */
  closeCalls: number;
  /** 模拟返回结果队列 */
  resultQueue: any[];
  /** 运行 Cypher */
  run(query: string, params?: Record<string, any>): Promise<any>;
  /** 关闭 session */
  close(): Promise<void>;
}

export interface MockDriver {
  /** 创建 session */
  session(): MockSession;
  /** 关闭 driver */
  close(): Promise<void>;
  /** 获取所有 session 的 run 调用 */
  getAllRunCalls(): CypherCall[];
  /** 预置下一个 session.run 返回 */
  queueResult(records: any[]): void;
  /** 预置多个返回值 */
  queueResults(results: any[][]): void;
  /** 当前 session 实例 */
  _currentSession: MockSession | null;
}

/** 创建 MockSession */
export function mockSession(initialResults: any[] = []): MockSession {
  const records = [...initialResults];
  return {
    runCalls: [],
    closeCalls: 0,
    resultQueue: records,
    async run(query: string, params: Record<string, any> = {}) {
      this.runCalls.push({ query, params });
      if (this.resultQueue.length > 0) {
        const r = this.resultQueue.shift();
        return {
          records: Array.isArray(r) ? r.map(mockRecord) : [],
          summary: { counters: { upserts: () => 0 } },
        };
      }
      return { records: [], summary: { counters: { upserts: () => 0 } } };
    },
    async close() {
      this.closeCalls++;
    },
  };
}

/** 创建 MockDriver */
export function mockDriver(): MockDriver {
  let currentSession: MockSession | null = null;
  const driver: MockDriver = {
    _currentSession: null,
    session() {
      if (!currentSession) {
        currentSession = mockSession();
      }
      driver._currentSession = currentSession;
      return currentSession;
    },
    async close() {},
    getAllRunCalls() {
      return currentSession?.runCalls ?? [];
    },
    queueResult(records: any[]) {
      if (!currentSession) currentSession = mockSession();
      currentSession.resultQueue.push(records);
    },
    queueResults(results: any[][]) {
      if (!currentSession) currentSession = mockSession();
      currentSession.resultQueue = [...results];
    },
  };
  return driver;
}
