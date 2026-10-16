import type { Metadata } from "next";
import { THEME_BOOT } from "@/components/ThemeToggle";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "TA FAQ", template: "%s · TA FAQ" },
  description: "Point Mobile TA 팀 FAQ — 처리한 이슈의 기록과 해결 가이드",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
