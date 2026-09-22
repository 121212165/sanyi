"""Read a recorded game from .local/records/ and report what the engine measured.

How a move gets a number: every ply's post-move winrate is recorded — by the engine's own search for
its moves, and by a forced `allowMoves` search for yours. The position *before* your move is exactly
the position after the engine's previous move, so the loss of your move is the difference between
those two, both expressed from your own side's point of view.

A move with no number is reported as unmeasured; it is never guessed.

  py -3.12 tools/analyze_record.py                # latest game
  py -3.12 tools/analyze_record.py go-mucl29r3    # a specific game
  py -3.12 tools/analyze_record.py --all          # every game, aggregate
"""
from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

RECORDS = Path(__file__).resolve().parent.parent / ".local" / "records"

# Winrate loss, in percentage points, that makes us call a move bad.
MISTAKE_PP = 8.0
BLUNDER_PP = 15.0
SOFT_PP = 4.0


def load(game_id: str) -> list[dict]:
    path = RECORDS / f"{game_id}.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def build(events: list[dict]) -> dict:
    start = next((e for e in events if e.get("t") == "start"), {})
    end = next((e for e in events if e.get("t") == "end"), None)
    moves = [e for e in events if e.get("t") == "move"]
    forced = {(e["ply"], e["vertex"]): e for e in events if e.get("t") == "eval"}

    plies = []
    for m in moves:
        vertex, by, color = m["vertex"], m.get("by"), m["color"]
        b = m.get("baseline") or {}
        ev = forced.get((m["ply"], vertex))
        wr, visits, source = None, None, None
        if by == "engine":
            wr, visits, source = b.get("playedWinrate"), b.get("visits"), "engine-search"
        if wr is None and ev is not None and ev.get("winrate") is not None:
            wr, visits, source = ev["winrate"], ev.get("visits"), "forced-search"
        if wr is None and b.get("playedWinrate") is not None:
            wr, visits, source = b["playedWinrate"], b.get("playedVisits"), "pre-move-baseline"
        # Recorded winrates are from the mover's side. Normalize to black before differencing,
        # otherwise a white move's 0.92 minus a black move's 0.01 reads as a 90-point blunder.
        bw = None if wr is None else (wr if color == "black" else 1 - wr)
        plies.append({"ply": m["ply"], "by": by, "color": color, "vertex": vertex, "wr": wr, "bw": bw,
                      "visits": visits, "source": source, "clock": m.get("clock")})

    rows = []
    for i, p in enumerate(plies):
        if p["by"] != "user":
            continue
        before_bw = plies[i - 1]["bw"] if i else None  # the engine's previous move left this very position
        loss = None
        if p["bw"] is not None and before_bw is not None:
            mine_before = before_bw if p["color"] == "black" else 1 - before_bw
            mine_after = p["bw"] if p["color"] == "black" else 1 - p["bw"]
            loss = round((mine_before - mine_after) * 100, 1)
        rows.append({**p, "before": before_bw, "loss_pp": loss, "measured": loss is not None})

    measured = [r for r in rows if r["measured"]]
    losses = [r["loss_pp"] for r in measured]
    engine = (start.get("engine") or {}).get("strength") or {}
    return {
        "game": start.get("gameId"),
        "at": start.get("at"),
        "mode": start.get("mode"),
        "timeControl": start.get("timeControl") or {},
        "userColor": start.get("userColor", "black"),
        "engine": engine.get("note"),
        "throughput": engine.get("throughput"),
        "result": (end or {}).get("result"),
        "reason": (end or {}).get("reason"),
        "plies": plies,
        "rows": rows,
        "measured": measured,
        "losses": losses,
        "avg": round(statistics.fmean(losses), 2) if losses else None,
        "median": round(statistics.median(losses), 2) if losses else None,
        "p90": round(sorted(losses)[max(0, int(len(losses) * 0.9) - 1)], 1) if losses else None,
        "blunders": len([x for x in losses if x >= BLUNDER_PP]),
        "mistakes": len([x for x in losses if MISTAKE_PP <= x < BLUNDER_PP]),
        "soft": len([x for x in losses if SOFT_PP <= x < MISTAKE_PP]),
        "clean": len([x for x in losses if x < SOFT_PP]),
        "finalWr": plies[-1]["wr"] if plies and plies[-1]["color"] else None,
    }


def classify(loss):
    if loss is None:
        return "未测量"
    if loss >= BLUNDER_PP:
        return "大漏"
    if loss >= MISTAKE_PP:
        return "失误"
    if loss >= SOFT_PP:
        return "欠佳"
    return "正常"


def report(a: dict, verbose=True) -> None:
    tc = a["timeControl"]
    tc_text = "不限时" if tc.get("kind") == "untimed" else (
        f"{(tc.get('baseMs') or tc.get('mainMs') or 0) / 60000:.0f}分+{tc.get('incMs', 0) / 1000:.0f}秒"
        if tc.get("kind") == "blitz" else f"读秒 {tc.get('mainMs', 0) / 60000:.0f}分"
    )
    tp = a.get("throughput") or {}
    print(f"\n=== {a['game']}  {a['at']}")
    print(f"  {a['mode']} · {tc_text} · 执{'黑' if a['userColor'] == 'black' else '白'}")
    print(f"  引擎 {a['engine']}" + (f" · {tp.get('value')} {tp.get('unit')}" if tp else ""))
    print(f"  共 {len(a['plies'])} 手，你 {len(a['rows'])} 手，其中 {len(a['measured'])} 手可量化")
    if a["result"]:
        print(f"  结果 {a['result']}（{a['reason']}）")
    last = [p for p in a["plies"] if p["bw"] is not None]
    if last:
        bw = last[-1]["bw"]
        mine = bw if a["userColor"] == "black" else 1 - bw
        verdict = "领先" if mine > 0.6 else "落后" if mine < 0.4 else "均势"
        print(f"  当前局面黑方胜率 {bw * 100:.1f}% → 你{verdict}（你的胜率 {mine * 100:.1f}%）")
    if not a["measured"]:
        print("  没有可量化的着法。")
        return
    print(f"  每手平均亏 {a['avg']}pp · 中位 {a['median']} · 90分位 {a['p90']}")
    print(f"  分布：正常 {a['clean']} / 欠佳 {a['soft']} / 失误 {a['mistakes']} / 大漏 {a['blunders']}")
    if not verbose:
        return
    worst = sorted(a["measured"], key=lambda r: -(r["loss_pp"] or 0))[:6]
    print("  最伤的几手：")
    for r in worst:
        before_mine = r["before"] if r["color"] == "black" else 1 - r["before"]
        after_mine = r["wr"] if r["color"] == "black" else 1 - r["wr"]
        print(f"    第{r['ply'] + 1:>3}手 {r['vertex']:<5} {classify(r['loss_pp']):<4} 亏 {r['loss_pp']:>5.1f}pp   "
              f"{before_mine * 100:.1f}% → {after_mine * 100:.1f}%  ({r['visits']} visits, {r['source']})")
    unmeasured = [r for r in a["rows"] if not r["measured"]]
    if unmeasured:
        print(f"  另有 {len(unmeasured)} 手没有数值（求值未回来或未开启完整记录）")


def main() -> None:
    if not RECORDS.exists():
        print(f"no records at {RECORDS}")
        return
    games = sorted(p.stem for p in RECORDS.glob("*.jsonl"))
    if not games:
        print("no games recorded yet")
        return
    if "--all" in games or (sys.argv[1:] and sys.argv[1] == "--all"):
        sums = [build(load(g)) for g in games]
        sums = [s for s in sums if s["plies"]]
        for s in sums:
            report(s, verbose=False)
        quant = [s for s in sums if s["measured"]]
        print(f"\n--- {len(sums)} 盘，{len(quant)} 盘可量化")
        if quant:
            all_losses = [l for s in quant for l in s["losses"]]
            print(f"    合计 {len(all_losses)} 手有数值：平均亏 {round(statistics.fmean(all_losses), 2)}pp，"
                  f"中位 {round(statistics.median(all_losses), 2)}pp")
            print(f"    正常 {sum(s['clean'] for s in quant)} / 欠佳 {sum(s['soft'] for s in quant)} / "
                  f"失误 {sum(s['mistakes'] for s in quant)} / 大漏 {sum(s['blunders'] for s in quant)}")
            print(f"    每盘平均 {round(sum(len(s['rows']) for s in quant) / len(quant), 1)} 手你的棋")
            worst_game = min(quant, key=lambda s: s["avg"])
            best_game = max(quant, key=lambda s: s["avg"])
            print(f"    最稳一盘 {best_game['game']}（均 {best_game['avg']}pp），最伤一盘 {worst_game['game']}（均 {worst_game['avg']}pp）")
        return
    target = sys.argv[1] if len(sys.argv) > 1 else games[-1]
    events = load(target)
    if not events:
        print(f"no such game: {target}\navailable: {', '.join(games)}")
        return
    report(build(events))


if __name__ == "__main__":
    main()
