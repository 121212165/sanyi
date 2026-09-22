import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '三弈 · 围棋对局台',
  description: '满强度引擎对局 + 引擎数据讲解 + 复盘推演',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <body>{children}</body>
    </html>
  );
}
