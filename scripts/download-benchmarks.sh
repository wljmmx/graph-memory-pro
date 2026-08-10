#!/usr/bin/env bash
#
# v2.3.6: 下载 Benchmark 真实数据集（LoCoMo / LongMemEval / LongMemEval-V2）
#
# 用法：
#   bash scripts/download-benchmarks.sh              # 下载全部
#   bash scripts/download-benchmarks.sh locomo       # 仅 LoCoMo
#   bash scripts/download-benchmarks.sh longmemeval  # 仅 LongMemEval（V1）
#   bash scripts/download-benchmarks.sh longmemeval-v2  # 仅 LongMemEval-V2
#
# 下载后需运行预处理生成标准化数据集：
#   npm run preprocess:benchmarks
#
# 数据来源：
#   - LoCoMo:          https://github.com/snap-research/locomo  (locomo10.json)
#   - LongMemEval:     https://github.com/xiaowu0162/LongMemEval
#   - LongMemEval-V2:  https://github.com/xiaowu0162/LongMemEval-V2
#                      HuggingFace: xiaowu0162/longmemeval-v2（国内走 hf-mirror.com 镜像）
#                      （questions.jsonl / trajectories.jsonl / haystacks/*.json）
#
# LongMemEval-V2 说明：
#   - 采用「问题 + 轨迹历史 + haystack」三层结构，轨迹为多模态 Web-Agent 会话。
#   - 本脚本下载评测必需的核心文件（questions / trajectories / haystacks）；
#     截图归档（trajectory_screenshots/*.tar.gz）体积巨大，且文本图谱评测不依赖，
#     默认不下载。如需完整快照，可用官方脚本：
#         python data/download_data.py --data-root benchmarks/data/longmemeval-v2
#
# 注意：LongMemEval（V1）原始文件路径/命名可能随上游变动，脚本会尝试常见路径；
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

# ── LongMemEval-V2 ──
# 官方 HuggingFace 数据集: xiaowu0162/longmemeval-v2
# 国内网络请使用 HFAI 镜像 hf-mirror.com（已设为默认），海外可改回官方域名。
# 核心文件直链：
#   questions.jsonl / trajectories.jsonl / haystacks/lme_v2_{small,medium}.json
# 截图归档不下载（体积巨大，文本图谱评测不依赖）。
HF_BASE="${GM_HF_BASE:-https://hf-mirror.com/datasets/xiaowu0162/longmemeval-v2/resolve/main}"
V2_DIR="$DATA_DIR/longmemeval-v2"

if [ "$TARGET" = "all" ] || [ "$TARGET" = "longmemeval-v2" ]; then
  mkdir -p "$V2_DIR/haystacks"
  download "$HF_BASE/questions.jsonl" "$V2_DIR/questions.jsonl"
  download "$HF_BASE/trajectories.jsonl" "$V2_DIR/trajectories.jsonl"
  download "$HF_BASE/haystacks/lme_v2_small.json" "$V2_DIR/haystacks/lme_v2_small.json"
  download "$HF_BASE/haystacks/lme_v2_medium.json" "$V2_DIR/haystacks/lme_v2_medium.json"
  echo "ℹ LongMemEval-V2 核心文件已就绪于 $V2_DIR"
  echo "  （截图归档未下载。如需完整多模态快照，请用官方脚本："
  echo "     python data/download_data.py --data-root $V2_DIR ）"
fi

echo ""
echo "══════════════════════════════════════════════════════"
echo "下载完成。下一步运行预处理生成标准化数据集:"
echo "  npm run preprocess:benchmarks"
echo "══════════════════════════════════════════════════════"