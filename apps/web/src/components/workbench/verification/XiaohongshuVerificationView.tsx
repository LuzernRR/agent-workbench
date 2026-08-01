"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { CheckCircle2, LoaderCircle, ShieldCheck, XCircle } from "lucide-react";
import { resolveWorkbenchResourceUrl } from "@/lib/api/client";

type VerificationStatus = {
  version: 1;
  runId: string;
  challengeId: string;
  status: "pending" | "succeeded" | "expired" | "account_mismatch" | "failed" | "cancelled";
  expiresAt: string;
  retryAfterMs: number;
  reasonCode: string | null;
  message: string;
};

function statusLabel(status: VerificationStatus["status"]) {
  return {
    pending: "等待扫码",
    succeeded: "验证成功",
    expired: "验证已超时",
    account_mismatch: "账号不一致",
    failed: "验证未完成",
    cancelled: "验证已取消"
  }[status];
}

function remainingLabel(expiresAt: string, now: number) {
  const remaining = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function XiaohongshuVerificationView({ runId, challengeId }: { runId: string; challengeId: string }) {
  const encodedRunId = encodeURIComponent(runId);
  const encodedChallengeId = encodeURIComponent(challengeId);
  const apiPath = useMemo(() => resolveWorkbenchResourceUrl(
    `/api/v1/runs/${encodedRunId}/xiaohongshu-verifications/${encodedChallengeId}`
  ), [encodedChallengeId, encodedRunId]);
  const [status, setStatus] = useState<VerificationStatus | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const response = await fetch(apiPath, { cache: "no-store", headers: { accept: "application/json" } });
        const payload = await response.json() as VerificationStatus | { message?: string };
        if (!response.ok) throw new Error("message" in payload && payload.message ? payload.message : "验证状态暂不可用");
        if (disposed) return;
        const next = payload as VerificationStatus;
        setStatus(next);
        setError("");
        if (next.status === "pending") {
          timer = setTimeout(poll, Math.min(5_000, Math.max(500, next.retryAfterMs)));
        }
      } catch (reason) {
        if (disposed) return;
        setError(reason instanceof Error ? reason.message : "验证状态暂不可用");
        timer = setTimeout(poll, 2_000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [apiPath]);

  useEffect(() => {
    if (status?.status !== "pending") return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [status?.status]);

  const cancel = async () => {
    setCancelling(true);
    try {
      const response = await fetch(apiPath, { method: "DELETE", cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(payload?.message || "取消验证失败");
      }
      setStatus((current) => current ? { ...current, status: "cancelled", message: "已取消小红书工具账号验证", reasonCode: "USER_CANCELLED" } : current);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "取消验证失败");
    } finally {
      setCancelling(false);
    }
  };

  const pending = status?.status === "pending";
  const succeeded = status?.status === "succeeded";
  return <main className="min-h-screen bg-canvas px-5 py-10 text-ink sm:px-8">
    <section className="mx-auto w-full max-w-lg rounded-2xl border border-line bg-panel p-6 shadow-sm sm:p-8" aria-live="polite">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-xl bg-muted p-2.5 text-secondary"><ShieldCheck className="size-5" /></div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">验证小红书工具账号</h1>
          <p className="mt-1 text-sm leading-6 text-secondary">此二维码来自触发当前搜索的隔离工具会话。扫码账号必须与原工具账号一致，成功后原运行会自动继续。</p>
        </div>
      </div>

      {!status && !error ? <div className="mt-8 flex items-center justify-center gap-2 py-12 text-secondary"><LoaderCircle className="size-5 animate-spin" />正在连接验证会话</div> : null}

      {pending ? <div className="mt-7">
        <div className="mx-auto flex aspect-square w-full max-w-[300px] items-center justify-center overflow-hidden rounded-2xl border border-line bg-white p-4">
          {imageFailed
            ? <p className="px-4 text-center text-sm leading-6 text-danger">二维码暂未加载，请刷新此页重试。</p>
            : <Image
                src={`${apiPath}/qrcode`}
                alt="小红书工具账号安全验证二维码"
                width={300}
                height={300}
                unoptimized
                className="h-full w-full object-contain"
                referrerPolicy="no-referrer"
                onError={() => setImageFailed(true)}
              />}
        </div>
        <div className="mt-4 flex items-center justify-between gap-4 text-sm text-secondary">
          <span>{status.message}</span>
          <span className="shrink-0 tabular-nums">剩余 {remainingLabel(status.expiresAt, now)}</span>
        </div>
        <button type="button" className="mt-5 w-full rounded-xl border border-line px-4 py-2.5 text-sm font-medium text-secondary hover:bg-muted disabled:opacity-50" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "正在取消" : "取消验证"}</button>
      </div> : null}

      {status && !pending ? <div className="mt-8 rounded-2xl border border-line bg-muted/60 px-5 py-6 text-center">
        {succeeded ? <CheckCircle2 className="mx-auto size-9 text-success" /> : <XCircle className="mx-auto size-9 text-warning" />}
        <h2 className="mt-3 text-base font-semibold">{statusLabel(status.status)}</h2>
        <p className="mt-1 text-sm leading-6 text-secondary">{status.message}</p>
        {succeeded ? <p className="mt-2 text-sm text-secondary">当前搜索正在后台继续，可关闭此页面。</p> : null}
      </div> : null}

      {error ? <p className="mt-4 rounded-xl bg-danger/10 px-4 py-3 text-sm leading-6 text-danger" role="alert">{error}</p> : null}
      <a href="/workbench" className="mt-6 inline-flex text-sm font-medium text-link hover:underline">返回 Workbench</a>
    </section>
  </main>;
}
