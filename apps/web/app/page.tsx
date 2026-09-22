export default function Home() {
  return (
    <main className="center">
      <h1>三弈</h1>
      <p className="muted">围棋 / 国际象棋 / 中国象棋 · 满强度引擎对局与训练台</p>
      <nav>
        <a className="cta" href="/play">进入围棋对局台</a>
      </nav>
      <p className="muted small">
        引擎跑在本机（<code>npm run bridge</code>）。网页只是显示器：棋钟由本地桥接进程计时，
        切标签页不会偷走你的时间。
      </p>
    </main>
  );
}
