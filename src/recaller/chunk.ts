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
 * 强边界：段落/句末。切点落在此类字符之后时，句子是完整的。
 * 分块时优先选这类切点——「不把句子劈开」靠的就是它。
 */
const STRONG_BOUNDARY = new Set([
  "\n",
  "。", "！", "？", "!", "?", "；", ";", "…",
]);

/**
 * 弱边界：句内分句（逗号/顿号/冒号/右括号等）。
 * 仅在窗口内找不到任何强边界时才使用（如单句本身超过 chunkSize），
 * 属于「必须断句」时的次优选择——仍比硬切一个字符好。
 */
const WEAK_BOUNDARY = new Set([
  "，", ",", "、", "：", ":",
  "）", ")", "】", "」", "』",
]);

/**
 * 最小填充比例：切点不得让本段短于 chunkSize 的该比例，
 * 否则宁可继续往后找/硬切（避免过早出现的标点切出过短段，段数暴涨）。
 */
const MIN_FILL_RATIO = 0.5;

/**
 * 在 (minEnd, hardEnd] 内寻找最靠右的指定边界切点（返回「边界后一位」下标）。
 * 找不到返回 -1。
 */
function lastBoundaryIn(
  text: string,
  minEnd: number,
  hardEnd: number,
  boundary: Set<string>,
): number {
  for (let p = hardEnd; p > minEnd; p--) {
    if (boundary.has(text[p - 1])) return p;
  }
  return -1;
}

/**
 * 在 (minEnd, hardEnd] 内挑选切点，按边界强度分级：
 *   1) 强边界（段落/句末）——句子完整，最优
 *   2) 弱边界（分句标点）——句子被劈开，但断在自然停顿处
 *   3) 硬切 hardEnd    ——界内无任何标点（如无标点长串），不可避免
 *
 * 关键点：先找强边界，找到就用，即使窗口更靠右处存在弱边界。
 * 例如窗口内句末 。在 300、逗号在 390，选 300 而非 390——
 * 后者会把下一句从中间劈开（此前实现的缺陷）。
 */
function pickCut(text: string, minEnd: number, hardEnd: number): number {
  const strong = lastBoundaryIn(text, minEnd, hardEnd, STRONG_BOUNDARY);
  if (strong > 0) return strong;
  const weak = lastBoundaryIn(text, minEnd, hardEnd, WEAK_BOUNDARY);
  if (weak > 0) return weak;
  return hardEnd; // 兜底硬切
}

/**
 * 将文本分段（含重叠）。
 *
 * 切点由「语义单元边界」决定，长度只作为预算——不是按定长切：
 * - 文本长度 <= chunkSize → 返回单段（原文）
 * - 每段切点优先落在段落/句末边界（强边界），句子不被劈开
 * - 窗口内无强边界时退到分句标点（弱边界），仍无则硬切
 * - 每段长度 ≤ chunkSize（不越过预算去凑整句）
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
    // 仅在本段之后仍有内容时才挑选切点（末段直接切到文本末尾）
    const end = hardEnd < text.length
      ? pickCut(text, start + minFill - 1, hardEnd)
      : hardEnd;
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    // 重叠：下一段回退 overlap 个字符（重叠落在本段预算内，故每段仍 ≤ chunkSize）。
    // 回退量 >= 本段长度时（极端 overlap 配置）放弃重叠，保证严格前进不死循环。
    const next = end - overlap;
    start = next > start ? next : end;
  }
  return chunks;
}

/**
 * v2.8.x: **代理对安全**的截断。
 *
 * 缺陷背景：JS 的 `String.prototype.slice` 按 **UTF-16 码元**切割。若切点落在
 * 代理对（emoji / CJK 扩展字 / 部分符号）中间，会切出**孤立代理项**
 * （如 `"👍".slice(0,1)` → `"\uD83D"`）。后果有两层：
 *   ① 语义损坏：送到嵌入模型的文本在字符中间断掉；
 *   ② 传输层面：`JSON.stringify` 会把它输出为**未配对代理转义** `\ud83d`，
 *      而部分严格 JSON 解析器（serde_json、部分 C++/Go 严格模式）会**直接拒绝**，
 *      表现为 `Cannot parse JSON body` —— 纯中文/ASCII 的 curl 测试永远复现不到。
 *
 * 规则：若 `max` 处恰好把一对高/低代理拆开，则少取一位（宁可短 1 个码元）。
 */
export function safeSlice(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";
  const prev = text.charCodeAt(max - 1);
  const next = text.charCodeAt(max);
  const splitPair =
    prev >= 0xd800 && prev <= 0xdbff && // 高代理
    next >= 0xdc00 && next <= 0xdfff; // 低代理
  return text.slice(0, splitPair ? max - 1 : max);
}

/**
 * v2.8.x: 移除字符串中的**孤立代理项**（保留合法的代理对），并剔除 NUL。
 *
 * 用途：出站前净化。库里的历史内容可能**已经**含有早前截断产生的孤立代理
 * （旧版本 `slice` 的产物）—— 仅修截断逻辑救不回存量数据，必须在发送前净化，
 * 否则这些节点会持续失败，且看起来像"服务端问题"。
 */
export function stripLoneSurrogates(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      // 高代理：必须紧跟低代理才保留
      const n = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) {
        out += text[i] + text[i + 1];
        i++;
      } // 否则丢弃（孤立高代理）
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue; // 孤立低代理 → 丢弃
    if (c === 0x0000) continue; // NUL → 丢弃（对嵌入无语义价值，且是解析器常见拒收项）
    out += text[i];
  }
  return out;
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
    return { texts: [safeSlice(full, sliceChars)], chunked: false };
  }

  const chunking = params.chunking;
  const chunks = chunkText(full, {
    chunkSize: chunking?.chunkSize,
    chunkOverlap: chunking?.chunkOverlap,
  });
  if (chunks.length <= 1) {
    return { texts: [safeSlice(full, sliceChars)], chunked: false };
  }
  // 分块模式下每段再按 memorySliceChars 兜底截断（防止单段仍过长）
  return { texts: chunks.map((c) => safeSlice(c, sliceChars)), chunked: true };
}