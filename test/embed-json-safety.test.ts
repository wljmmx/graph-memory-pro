/**
 * v2.8.x — 嵌入请求体的字符安全与拼装正确性
 *
 * 回答两个具体质疑：
 *   ① 「openai/OVMS 不接受 keep_alive 等参数，是否送错了？」
 *   ② 「JSON 拼装是否含异常字符 / 是否拼装有问题？」
 *
 * 已证实的缺陷：JS `slice` 按 **UTF-16 码元**切割，截断落在代理对中间会产生
 * **孤立代理项**（`"👍".slice(0,1)` → `"\uD83D"`）。`JSON.stringify` 会把它输出为
 * **未配对代理转义** `\ud83d`，而部分严格 JSON 解析器（serde_json、部分 C++/Go
 * 严格模式）会**直接拒绝** → 表现为 `Cannot parse JSON body`（412）。
 * 纯中文/ASCII 的 curl 测试**永远复现不到**，这解释了"curl 200 而插件被拒"。
 */
import { describe, it, expect } from "vitest";
import { buildEmbedRequestBody } from "../src/engine/embed.ts";
import { safeSlice, stripLoneSurrogates, buildEmbedTexts } from "../src/recaller/chunk.ts";

/** 字符串中是否存在孤立代理项（严格 JSON 解析器的常见拒收项） */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** 整个请求体（喂给严格 JSON 解析器的字节）是否干净 */
function bodyIsStrictJsonSafe(bodyStr: string): boolean {
  if (hasLoneSurrogate(bodyStr)) return false;
  // 未配对代理转义（\ud83d 后不接低代理转义）也是严格解析器的常见拒收项
  return !/\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F][0-9a-fA-F]{2})/.test(bodyStr);
}

describe("嵌入请求体：openai 格式不夹带 Ollama 专有字段", () => {
  it("openai 只含 model + input —— 绝无 keep_alive / options", () => {
    const body = buildEmbedRequestBody(
      { apiFormat: "openai", model: "qwen-embedding", keepAlive: "1h", options: { num_ctx: 4096 } },
      ["a", "b"],
    );
    expect(Object.keys(body).sort()).toEqual(["input", "model"]);
    expect(body).not.toHaveProperty("keep_alive");
    expect(body).not.toHaveProperty("options");
  });

  it("ollama 才带 keep_alive / options", () => {
    const body = buildEmbedRequestBody(
      { apiFormat: "ollama", model: "m", keepAlive: "1h", options: { num_ctx: 4096 } },
      ["a"],
    );
    expect(Object.keys(body).sort()).toEqual(["input", "keep_alive", "model", "options"]);
  });
});

describe("safeSlice / stripLoneSurrogates：代理对安全", () => {
  it("safeSlice 不切开代理对（这正是历史缺陷的产生点）", () => {
    const s = "abcdefg👍hijklmn";
    // 先证明原生 slice 确实会切出孤立代理（缺陷存在性）
    expect(hasLoneSurrogate(s.slice(0, 8))).toBe(true);
    // safeSlice 不得切开
    const out = safeSlice(s, 8);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).toBe("abcdefg"); // 少取一位，保住字符完整性
  });

  it("safeSlice 不误伤：切点不在代理对内时行为与 slice 等价", () => {
    expect(safeSlice("abcdefgh", 5)).toBe("abcde");
    expect(safeSlice("👍👍👍", 2)).toBe("👍"); // 正好切在字符边界
  });

  it("safeSlice 边界：超长原文原样返回、max<=0 返回空", () => {
    expect(safeSlice("abc", 10)).toBe("abc");
    expect(safeSlice("abc", 0)).toBe("");
    expect(safeSlice("abc", -1)).toBe("");
  });

  it("stripLoneSurrogates 剔除孤立代理但保留合法代理对", () => {
    expect(stripLoneSurrogates("a\uD83Db")).toBe("ab");       // 孤立高代理
    expect(stripLoneSurrogates("a\uDE00b")).toBe("ab");       // 孤立低代理
    expect(stripLoneSurrogates("a👍b")).toBe("a👍b");         // 合法对保留
    expect(stripLoneSurrogates("a\u0000b")).toBe("ab");       // NUL 剔除
  });

  it("净化后请求体对严格解析器安全（未配对代理转义已消失）", () => {
    const dirty = "abcdefg👍hijklmn".slice(0, 8); // 含孤立高代理
    // 净化前：直接用原始脏串手工拼装，证明它确实会被严格解析器拒收
    const before = JSON.stringify({ model: "m", input: [dirty] });
    expect(before).toContain("\\ud83d");
    expect(bodyIsStrictJsonSafe(before)).toBe(false);

    // 净化后：buildEmbedRequestBody 已内建净化 → 出站即安全
    const after = JSON.stringify(buildEmbedRequestBody({ apiFormat: "openai", model: "m" }, [dirty]));
    expect(after).not.toContain("\\ud83d");
    expect(bodyIsStrictJsonSafe(after)).toBe(true);
  });

  it("端到端：buildEmbedTexts 的截断不再产生孤立代理（真实 800 字符切片点）", () => {
    // 让第 800 个码元落在 emoji 的高代理上
    const content = "x".repeat(799) + "👍" + "后续内容";
    const { texts } = buildEmbedTexts({ name: "n", description: "d", content, memorySliceChars: 800 });
    expect(texts).toHaveLength(1);
    expect(hasLoneSurrogate(texts[0])).toBe(false);
    // 且请求体层面也干净
    const body = JSON.stringify(buildEmbedRequestBody({ apiFormat: "openai", model: "m" }, texts));
    expect(bodyIsStrictJsonSafe(body)).toBe(true);
  });
});