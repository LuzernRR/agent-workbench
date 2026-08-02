"""离线评测入口：`uv run python -m app.evaluation.cli`。

默认使用仓库内 Gold 数据集，全程离线；失败时以非零退出码结束，可直接接入门禁。
"""

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from app.evaluation.dataset import load_dataset
from app.evaluation.report import build_report
from app.evaluation.runner import run_dataset


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Search Agent 离线评测")
    parser.add_argument(
        "--dataset",
        type=Path,
        default=None,
        help="Gold 数据集路径，默认使用 evaluation/gold/search-agent.json",
    )
    parser.add_argument(
        "--json-out",
        type=Path,
        default=None,
        help="可选：把机器可读报告写入该路径",
    )
    args = parser.parse_args(argv)

    dataset = load_dataset(args.dataset)
    runs = asyncio.run(run_dataset(dataset))
    report = build_report(dataset.name, runs)

    if args.json_out is not None:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(report.to_json(), encoding="utf-8")

    print(report.to_markdown())
    return 0 if report.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
