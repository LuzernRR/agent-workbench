import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "平台万能搜",
  description: "面向网页、小红书与 X 的智能搜索工作台。"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body><Providers>{children}</Providers></body></html>;
}
