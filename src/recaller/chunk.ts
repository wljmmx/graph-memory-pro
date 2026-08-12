/**
 * v2.4.0 长文本分段嵌入工具（点 6）
 *
 * 纯函数，无外部依赖，便于单测：
 * - chunkText: 按字符长度切分文本（含重叠），避免长文本超长或关键上下文被截断
 * - buildEmbedText: 构造用于嵌入的文本（name: desc\ncontent），并做记忆切片
 */

export interface ChunkOptions {
  /** 单段字符数（默认 400） */
  chunkSize: number;
  /** 段间重叠字符数（默认 40） */
  chunkOverlap: number;
}

export const DEFAULT_CHUNK_SIZE = 400;
export const DEFAULT_CHUNK_OVERLAP = 40;

/**
 * 将文本按字符切分为若干段（含重叠）。
 *
 * - 文本长度 <= chunkSize → 返回单段（原文）
 * - chunkOverlap >= chunkSize 时自动收敛为 chunkSize-1，避免死循环
 * - 空文本 → 返回空数组
 */
export function chunkText(text: string, opts: Partial<ChunkOptions> = {}): string[] {
  const chunkSize = Math.max(1, opts.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const rawOverlap = Math.max(0, opts.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP);
  const overlap = Math.min(rawOverlap, chunkSize - 1);

  if (!text) return [];
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;
  const step = chunkSize - overlap;
  while (start < text.length) {
    const end = Math.min(text.length, start + chunkSize);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start += step;
  }
  return chunks;
}

/**
 * 构造用于嵌入的文本：`name: description\ncontent`
 *
 * 点2：记忆切片长度由 memorySliceChars 控制（覆盖旧版硬编码 500）。
 * 点6：若启用 chunking 且文本超长，返回分块数组；否则返回单段切片。
 */
export function buildEmbedTexts(params: {
  name: string;
  description: string;
  content: string;
  memorySliceChars?: number;
  chunking?: { enabled?: boolean; chunkSize?: number; chunkOverlap?: number };
}): {
  /** 用于嵌入的文本片段（1 个或多个） */
  texts: string[];
  /** 是否发生了长文本分块 */
  chunked: boolean;
} {
  const sliceChars = Math.max(1, params.memorySliceChars ?? 800);
  const full = `${params.name}: ${params.description}\n${params.content}`;

  const chunkingEnabled = params.chunking?.enabled ?? false;
  if (!chunkingEnabled) {
    return { texts: [full.slice(0, sliceChars)], chunked: false };
  }

  const chunking = params.chunking;
  const chunks = chunkText(full, {
    chunkSize: chunking?.chunkSize,
    chunkOverlap: chunking?.chunkOverlap,
  });
  if (chunks.length <= 1) {
    return { texts: [full.slice(0, sliceChars)], chunked: false };
  }
  // 分块模式下每段再按 memorySliceChars 兜底截断（防止单段仍过长）
  return { texts: chunks.map((c) => c.slice(0, sliceChars)), chunked: true };
}