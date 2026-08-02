"""评测报告：确定性聚合、稳定序列化与人读摘要。"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from app.evaluation.runner import CaseRun
from app.evaluation.scorers import ALL_SCORERS, Scorer, ScoreResult, score_case


@dataclass
class CaseReport:
    """一个用例的完整判定。"""

    case_id: str
    tags: list[str]
    terminal_type: str
    scores: list[ScoreResult]

    @property
    def passed(self) -> bool:
        return all(score.passed for score in self.scores)

    def to_dict(self) -> dict[str, Any]:
        return {
            "caseId": self.case_id,
            "tags": list(self.tags),
            "terminalType": self.terminal_type,
            "passed": self.passed,
            "scores": [
                {
                    "name": score.name,
                    "passed": score.passed,
                    "detail": score.detail,
                    "failures": list(score.failures),
                }
                for score in self.scores
            ],
        }


@dataclass
class EvalReport:
    """整个数据集的聚合结果。"""

    dataset_name: str
    cases: list[CaseReport] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return all(case.passed for case in self.cases)

    @property
    def case_pass_rate(self) -> float:
        if not self.cases:
            return 0.0
        return sum(1 for case in self.cases if case.passed) / len(self.cases)

    def dimension_summary(self) -> dict[str, dict[str, int]]:
        """按 scorer 维度聚合通过/失败数；键顺序稳定。"""
        summary: dict[str, dict[str, int]] = {}
        for case in self.cases:
            for score in case.scores:
                bucket = summary.setdefault(score.name, {"passed": 0, "failed": 0})
                bucket["passed" if score.passed else "failed"] += 1
        return summary

    def failures(self) -> list[str]:
        """扁平化的失败清单，便于门禁直接输出。"""
        lines: list[str] = []
        for case in self.cases:
            for score in case.scores:
                lines.extend(
                    f"{case.case_id} / {score.name}: {failure}"
                    for failure in score.failures
                )
        return lines

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": 1,
            "dataset": self.dataset_name,
            "passed": self.passed,
            "caseCount": len(self.cases),
            "casePassRate": round(self.case_pass_rate, 4),
            "dimensions": self.dimension_summary(),
            "cases": [case.to_dict() for case in self.cases],
        }

    def to_json(self) -> str:
        return json.dumps(
            self.to_dict(),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    def to_markdown(self) -> str:
        """人读摘要；不含任何用例正文或问题原文。"""
        lines = [
            f"# 评测报告：{self.dataset_name}",
            "",
            f"- 结论：{'全部通过' if self.passed else '存在失败'}",
            f"- 用例数：{len(self.cases)}",
            f"- 用例通过率：{self.case_pass_rate:.1%}",
            "",
            "## 维度汇总",
            "",
            "| 维度 | 通过 | 失败 |",
            "| --- | --- | --- |",
        ]
        for name, bucket in sorted(self.dimension_summary().items()):
            lines.append(f"| {name} | {bucket['passed']} | {bucket['failed']} |")
        lines.extend(["", "## 用例明细", "", "| 用例 | 终态 | 结论 |", "| --- | --- | --- |"])
        for case in self.cases:
            verdict = "通过" if case.passed else "失败"
            lines.append(f"| {case.case_id} | {case.terminal_type} | {verdict} |")
        failures = self.failures()
        if failures:
            lines.extend(["", "## 失败明细", ""])
            lines.extend(f"- {failure}" for failure in failures)
        return "\n".join(lines) + "\n"


def build_report(
    dataset_name: str,
    runs: list[CaseRun],
    *,
    scorers: tuple[Scorer, ...] = ALL_SCORERS,
) -> EvalReport:
    """对已执行的用例聚合报告；不重新运行 Agent。"""
    cases = [
        CaseReport(
            case_id=run.case.case_id,
            tags=list(run.case.tags),
            terminal_type=str((run.terminal or {}).get("type") or "NONE"),
            scores=score_case(run, scorers),
        )
        for run in runs
    ]
    return EvalReport(dataset_name=dataset_name, cases=cases)
