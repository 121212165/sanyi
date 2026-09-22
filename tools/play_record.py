"""Plays a short game through the real UI so the recorder produces data worth analyzing.

  py -3.12 tools/play_record.py [moves]
"""
import sys
import time
from playwright.sync_api import sync_playwright

URL = "http://localhost:3100/play"
MOVES = sys.argv[1:] or ["D4", "Q16", "D16", "C3", "C17", "Q3", "E3", "F17"]


def click_vertex(page, vertex):
    idx = page.evaluate(
        """(v) => [...document.querySelectorAll('rect.hit')].findIndex(r => (r.querySelector('title')||{}).textContent === v)""",
        vertex,
    )
    if idx < 0:
        return False
    page.locator("rect.hit").nth(idx).click()
    return True


def wait_for_turn(page, seconds=90):
    """The engine's reply lands when the move list grows and it is black's turn again."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        st = page.evaluate(
            """() => ({
                phase: (document.querySelector('.thinking')||{}).textContent || '',
                count: document.querySelectorAll('.movelist li').length,
                dot: (document.querySelector('.dot')||{}).className,
                notice: (document.querySelector('.notice')||{}).textContent || ''
            })"""
        )
        if not st["phase"] and st["dot"].endswith("ok"):
            return st
        time.sleep(1.0)
    return None


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1500, "height": 950})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL, wait_until="domcontentloaded", timeout=180_000)
    page.wait_for_selector("rect.hit", timeout=90_000)
    page.select_option("select >> nth=0", "learn")
    page.select_option("select >> nth=1", "4")  # 不限时
    page.get_by_role("button", name="新对局").click()
    page.wait_for_timeout(1500)
    print("badge:", page.evaluate("() => document.querySelector('.badge').textContent"))
    print("stones at start:", page.evaluate("() => document.querySelectorAll('.movelist li').length"))

    played = 0
    for v in MOVES:
        before = page.evaluate("() => document.querySelectorAll('.movelist li').length")
        if not click_vertex(page, v):
            print(f"{v}: not clickable (occupied or off-board), skipping")
            continue
        st = wait_for_turn(page)
        after = page.evaluate("() => document.querySelectorAll('.movelist li').length")
        print(f"{v}: moves {before} -> {after}", "| notice:", (st or {}).get("notice", "")[:40])
        played += 1
        if after < before + 2:
            print("  engine did not reply; stopping early")
            break

    time.sleep(6)  # let the queued per-move evaluations land
    panel = page.evaluate("() => (document.querySelector('.panel')||{}).innerText")
    print("\nengine panel now:\n", (panel or "")[:300])
    page.screenshot(path=".local/record-game.png")
    print("screenshot: .local/record-game.png")
    browser.close()

print("user moves played:", played)
if errors:
    print("JS errors:", errors[:5])
