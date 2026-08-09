#!/usr/bin/env bash
#
# v2.3.6: 下载 Benchmark 真实数据集（LoCoMo / LongMemEval）
#
# 用法：
#   bash scripts/download-benchmarks.sh            # 下载全部
#   bash scripts/download-benchmarks.sh locomo     # 仅 LoCoMo
#   bash scripts/download-benchmarks.sh longmemeval # 仅 LongMemEval
#
# 下载后需运行预处理生成标准化数据集：
#   npm run preprocess:benchmarks
#
# 数据来源：
#   - LoCoMo:      https://github.com/snap-research/locomo  (locomo10.json)
#   - LongMemEval: https://github.com/xiaowu0162/LongMemEval
#
# 注意：LongMemEval 原始文件路径/命名可能随上游变动，脚本会尝试常见路径；
#       若失败，请手动下载后放置到 benchmarks/data/longmemeval.jsonl。

set -euo pipefail

DATA_DIR="${GM_BENCHMARK_DATA_DIR:-benchmarks/data}"
mkdir -p "$DATA_DIR"

TARGET="${1:-all}"

download() {
  local url="$1"
  local dest="$2"
  if [ -f "$dest" ] && [ -s "$dest" ]; then
    echo "✔ 已存在，跳过: $dest"
    return 0
  fi
  echo "↓ 下载 $url → $dest"
  if command -v curl >/dev/null 2>&1; then
    curl -fSL --retry 3 -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$dest" "$url"
  else
    echo "✘ 需要 curl 或 wget" >&2
    exit 1
  fi
  echo "✔ 完成: $dest"
}

# ── LoCoMo ──
if [ "$TARGET" = "all" ] || [ "$TARGET" = "locomo" ]; then
  download \
    "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json" \
    "$DATA_DIR/locomo.json"
fi

# ── LongMemEval ──
if [ "$TARGET" = "all" ] || [ "$TARGET" = "longmemeval" ]; then
  if [ -f "$DATA_DIR/longmemeval.jsonl" ] && [ -s "$DATA_DIR/longmemeval.jsonl" ]; then
    echo "✔ 已存在，跳过: $DATA_DIR/longmemeval.jsonl"
  else
    echo "ℹ LongMemEval 原始文件路径随上游仓库变动，请手动下载后放置到:"
    echo "    $DATA_DIR/longmemeval.jsonl"
    echo "  参考: https://github.com/xiaowu0162/LongMemEval"
  fi
fi

echo ""
echo "══════════════════════════════════════════════════════"
echo "下载完成。下一步运行预处理生成标准化数据集:"
echo "  npm run preprocess:benchmarks"
echo "══════════════════════════════════════════════════════"