#!/usr/bin/env python3
"""
OVMS 嵌入端点诊断脚本（graph-memory-pro 排查工具）

目的：区分「配置错误」与「后端对特定请求形态间歇性拒绝」。
仅用标准库，不依赖第三方包。

用法：
    python3 scripts/diag-ovms-embed.py --url http://192.168.50.89:11412/v3/embeddings \
                                       --model qwen-embedding --dim 1024

为什么需要它：现场故障（`Embedding API 404: Mediapipe graph definition with requested
name is not found`）是**部分性**的 —— 同一 URL/模型有成功有失败，因此单纯的
"能不能通" 测试无法定位。本脚本分四个阶段把「请求形态」作为单一变量隔离出来：

    A 单条短文本        → 基线（你原本的测试相当于只做了这一步）
    B 8 条短文本        → 与插件的 batchSize 一致
    C 8 条长文本        → 与插件的真实输入长度一致（节点 name|description|content）
    D 长跑 N 次顺序请求 → 测「间歇性」：统计非 200 的比例与错误体

判读：
    仅 C 失败            → 后端对长输入/大载荷敏感 → 调小 batchSize / maxBatchChars
    仅 B、C 失败          → 后端不接受批量 input 数组 → 需按单条发送
    D 有非 200           → 间歇性资源问题 → 依赖插件侧的 404 重试 + 逐条降级（2.4.7 已加）
    D 正常但 E 失败       → **连接复用**是触发器（curl 每次都新建连接，插件复用 undici 连接池）
    全部 200             → 你无法在此端点复现，故障必与更长的输入或更高并发相关
"""
import argparse
import http.client
import json
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

# 模拟插件真实的「节点文本」形态：name | description | content 拼接
LONG_SEGMENT = (
    "本次会话讨论了图记忆插件的嵌入链路改造，包括批量装箱、子批次并发、"
    "失败降级与维度校验；涉及 OVMS 的 MediaPipe 图解析路径与 v3 兼容接口。"
)


def build_payload(texts: list[str], model: str) -> bytes:
    return json.dumps({"input": texts, "model": model}).encode("utf-8")


def call(url: str, texts: list[str], model: str, timeout: float) -> dict:
    """返回 {status, elapsed, n, dim, server, error_body}

    注意：urllib **不复用连接**（每次新建 TCP）。这与插件行为不同 ——
    插件用 Node 的 fetch（undici 连接池）会复用 keep-alive 连接。
    复用形态由 keepalive_probe() 单独覆盖。
    """
    req = urllib.request.Request(
        url, data=build_payload(texts, model),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            elapsed = time.time() - t0
            n = dim = None
            try:
                data = json.loads(raw)
                arr = data.get("data") or []
                n = len(arr)
                if arr and isinstance(arr[0].get("embedding"), list):
                    dim = len(arr[0]["embedding"])
            except Exception:
                pass
            return {"status": resp.status, "elapsed": elapsed, "n": n, "dim": dim,
                    "server": resp.headers.get("Server"), "error_body": None}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:300]
        return {"status": e.code, "elapsed": time.time() - t0, "n": None, "dim": None,
                "server": e.headers.get("Server") if e.headers else None, "error_body": body}
    except Exception as e:  # 连接/超时
        return {"status": -1, "elapsed": time.time() - t0, "n": None, "dim": None,
                "server": None, "error_body": str(e)[:300]}


def keepalive_probe(url: str, texts: list[str], model: str, rounds: int, timeout: float) -> list[dict]:
    """**单条 TCP 连接复用** N 次 —— 精确模拟插件（undici 连接池）的形态。

    与阶段 D 的唯一差别是「是否复用连接」。若本相失败而 D 正常，
    则触发器是连接复用（而非速率/载荷/并发），插件侧需改为每请求新建连接。
    """
    u = urllib.parse.urlparse(url)
    out: list[dict] = []
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=timeout)
    payload = build_payload(texts, model)
    try:
        for _ in range(rounds):
            t0 = time.time()
            conn.request("POST", u.path, body=payload,
                         headers={"Content-Type": "application/json"})
            resp = conn.getresponse()
            raw = resp.read()
            n = dim = None
            try:
                data = json.loads(raw)
                arr = data.get("data") or []
                n = len(arr)
                if arr and isinstance(arr[0].get("embedding"), list):
                    dim = len(arr[0]["embedding"])
            except Exception:
                pass
            out.append({
                "status": resp.status, "elapsed": time.time() - t0, "n": n, "dim": dim,
                "server": resp.getheader("Server"),
                "error_body": None if resp.status == 200 else raw.decode("utf-8", "replace")[:300],
            })
    except Exception as e:
        out.append({"status": -1, "elapsed": 0.0, "n": None, "dim": None,
                    "server": None, "error_body": f"connection died mid-run: {e}"[:300]})
    finally:
        conn.close()
    return out


def report(name: str, results: list[dict], expect_n: int, expect_dim: int) -> None:
    ok = [r for r in results if r["status"] == 200]
    bad = [r for r in results if r["status"] != 200]
    # 语义校验：200 但条数/维度不对，也是坏结果
    shape_bad = [r for r in ok if r["n"] != expect_n or (expect_dim and r["dim"] != expect_dim)]
    lat = [r["elapsed"] for r in results]
    print(f"\n── {name} ──")
    print(f"  请求数 {len(results)}   HTTP 200 {len(ok)}   非200 {len(bad)}   形态不符 {len(shape_bad)}")
    if lat:
        print(f"  延迟 中位 {statistics.median(lat)*1000:.0f}ms  最大 {max(lat)*1000:.0f}ms")
    servers = {r.get("server") for r in results if r.get("server")}
    if servers:
        # 仅如实记录，不臆断：若与预期后端不符（如 nginx/envoy），说明链路上另有中间件
        print(f"  Server 头: {', '.join(sorted(servers))}（与预期后端不符则链路上有中间件）")
    if shape_bad:
        s = shape_bad[0]
        print(f"  ⚠ 返回值形态不符：期望 {expect_n} 条 × {expect_dim or '?'} 维，实际 {s['n']} 条 × {s['dim'] or '?'} 维")
    # 按错误体聚合，便于看清是不是同一种后端错误
    seen: dict[str, int] = {}
    for r in bad:
        seen[r["error_body"] or f"status={r['status']}"] = seen.get(r["error_body"] or f"status={r['status']}", 0) + 1
    for body, cnt in seen.items():
        print(f"  非200 ×{cnt}: {body}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="完整端点，如 http://host:11412/v3/embeddings")
    ap.add_argument("--model", required=True)
    ap.add_argument("--dim", type=int, default=0, help="期望维度（如 1024），0=不校验")
    ap.add_argument("--rounds", type=int, default=60, help="阶段 D 的顺序请求次数")
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--batch", type=int, default=8, help="模拟插件的 batchSize")
    args = ap.parse_args()

    print(f"端点 {args.url}\n模型 {args.model}\n期望维度 {args.dim or '（不校验）'}")

    # A 单条短文本
    report("A 单条短文本", [call(args.url, ["今天天气不错"], args.model, args.timeout)], 1, args.dim)
    # B 批量短文本（与插件 batchSize 一致）
    short_batch = [f"今天天气不错 #{i}" for i in range(args.batch)]
    report(f"B {args.batch} 条短文本", [call(args.url, short_batch, args.model, args.timeout)], args.batch, args.dim)
    # C 批量长文本（与插件真实输入长度同量级）
    long_batch = [(LONG_SEGMENT * 8)[:900] + f" #{i}" for i in range(args.batch)]
    print(f"\n（C 阶段每条约 {len(long_batch[0])} 字符 —— 插件发送的是 name|description|content 拼接）")
    report(f"C {args.batch} 条长文本", [call(args.url, long_batch, args.model, args.timeout)], args.batch, args.dim)

    # D 间歇性：顺序长跑，内容每轮变化（避免后端缓存掩盖问题）
    results = []
    for i in range(args.rounds):
        texts = [(LONG_SEGMENT * 4)[:400] + f" round={i} idx={j}" for j in range(args.batch)]
        results.append(call(args.url, texts, args.model, args.timeout))
    report(f"D 顺序长跑 {args.rounds} 轮（每轮内容变化）", results, args.batch, args.dim)

    # E 单连接复用 —— 与 D 的唯一差别是「复用 TCP 连接」（= 插件的 undici 连接池形态）
    print("\n（E 阶段与 D 阶段唯一差别：E 复用同一条 TCP 连接，D 每次新建）")
    ka = keepalive_probe(args.url, long_batch, args.model, args.rounds, args.timeout)
    report(f"E 单连接复用 {args.rounds} 次（模拟插件的连接池）", ka, args.batch, args.dim)

    # 附：并发形态（插件的 maxConcurrency 默认 2）
    with ThreadPoolExecutor(max_workers=2) as ex:
        conc = list(ex.map(lambda i: call(args.url, long_batch, args.model, args.timeout), range(10)))
    report("附 并发 2 × 10 次（插件的 maxConcurrency 默认 2）", conc, args.batch, args.dim)

    print("\n── 判读 ──")
    print("  D 正常 + E 失败  → 触发器是**连接复用**：插件需改为每请求新建连接")
    print("  D、E 均失败      → 与连接无关：看 Server 头是否有代理，并把非 200 错误体发回")


if __name__ == "__main__":
    main()