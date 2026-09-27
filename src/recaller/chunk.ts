/**
 * v2.4.0 长文本分段嵌入工具（点 6）
 *
 * 纯函数，无外部依赖，便于单测：
 * - chunkText: 按结构边界（段落 → 句末 → 分句）切分文本（含重叠）
 * - buildEmbedText: 构造用于嵌入的文本（name: desc\ncontent），并做记忆切片
 *
 * v2.8.x: 切分从「定长字符切」改为「结构边界优先」。
 * 先前实现直接 text.slice(start, end)，不认句号/段落，会把一句话拦腰砍断
 * ——截断处语义不完整、段首语义漂移，局部匹配质量受损。
 * 现在切点会尽量吸附到最靠右的自然边界；仅当界内无可用边界
 * （如单句本身超过 chunkSize）时才退回硬切。
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
 * 自然边界字符：换行（段落/行）与中英文句末/分句标点。
 * 切点落在这些字符之后时，段尾是完整的语法单元。
 */
const BOUNDARY_CHARS = new Set([
  "\n",
  "。", "！", "？", "!", "?", "；", ";",
  "，", ",", "、", "：", ":",
  "）", ")", "】", "」", "』",
]);

/**
 * 最小填充比例：切点吸附不得让本段短于 chunkSize 的该比例，
 * 否则宁可硬切（避免过早出现的标点切出过短段，段数暴涨）。
 */
const MIN_FILL_RATIO = 0.5;

/**
 * 在 (minEnd, hardEnd] 内寻找最靠右的自然边界切点（返回“边界后一位”的下标）。
 * 找不到返回 -1，调用方退回硬切 hardEnd。
 */
function lastBoundaryIn(text: string, minEnd: number, hardEnd: number): number {
  for (let p = hardEnd; p > minEnd; p--) {
    if (BOUNDARY_CHARS.has(text[p - 1])) return p;
  }
  return -1;
}

/**
 * 将文本按 chunkSize 切分为若干段（含重叠）。
 *
 * - 文本长度 <= chunkSize → 返回单段（原文）
 * - 切点优先吸附到段落/句末/分句边界（最靠右者），无可用边界时硬切
 * - chunkOverlap >= chunkSize 时自动收敛为 chunkSize-1，避免死循环
 * - 空文本 → 返回空数组
 */
export function chunkText(text: string, opts: Partial<ChunkOptions> = {}): string[] {
  const chunkSize = Math.max(1, opts.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const rawOverlap = Math.max(0, opts.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP);
  const overlap = Math.min(rawOverlap, chunkSize - 1);

  if (!text) return [];
  if (text.length <= chunkSize) return [text];

  const minFill = Math.max(1, Math.floor(chunkSize * MIN_FILL_RATIO));
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const hardEnd = Math.min(text.length, start + chunkSize);
    let end = hardEnd;
    // 仅在本段之后仍有内容时才吸附边界（末段直接切到文本末尾）
    if (hardEnd < text.length) {
      const snapped = lastBoundaryIn(text, start + minFill - 1, hardEnd);
      if (snapped > start) end = snapped;
    }
    const chunk = text.slice(start, end);
    chunks.push(chunk);
    if (end >= text.length) break;
    // 重叠：下一段回退 overlap 个字符（重叠落在本段预算内，故每段仍 ≤ chunkSize）。
    // 回退量 >= 本段长度时（极端 overlap 配置）放弃重叠，保证严格前进不死循环。
    const next = end - overlap;
    start = next > start ? next : end;
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