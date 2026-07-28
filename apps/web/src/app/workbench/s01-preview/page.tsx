import { notFound } from "next/navigation";
import { WorkbenchEntry } from "@/components/workbench/entry/WorkbenchEntry";
import {
  isS01PreviewEnabled,
  loadS01PageFixture
} from "@/server/mock/s01-page-fixture";

export const dynamic = "force-dynamic";

export default async function S01PreviewPage({
  searchParams
}: {
  searchParams: Promise<{ s01?: string | string[] }>;
}) {
  if (!isS01PreviewEnabled()) notFound();
  const query = await searchParams;
  const fixture = await loadS01PageFixture(query.s01);
  if (!fixture) notFound();
  return <WorkbenchEntry initialThreadId="thread-product" s01ProcessFixture={fixture} />;
}
