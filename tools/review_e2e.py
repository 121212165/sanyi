"""End-to-end: play a short game in the real browser, then run the review panel and check
that every sentence it shows survives the evidence audit.

  py -3.12 tools/review_e2e.py
"""
import sys
import time
from playwright.sync_api import sync_playwright

URL = "http://localhost:3100/play"
PREFERRED = ["D4", "D16", "Q4", "Q16", "C3", "C17", "E4", "E16", "Q3", "D3", "C4", "C16"]
errors: list[str] = []


def click_next(page, taken):
    """The engine occupies points too, so play the first preferred point still available."""
    free = set(page.evaluate("() => [...document.querySelectorAll('rect.hit title')].map(t => t.textContent)"))
    want = next((v for v in PREFERRED if v in free and v not in taken), None)
    if want is None:
        page.locator("rect.hit").first.click()
        return True
    idx = page.evaluate(
        """(v) => [...document.querySelectorAll('rect.hit')].findIndex(r => (r.querySelector('title')||{}).textContent === v)""",
        want,
    )
    page.locator("rect.hit").nth(idx).click()
    return True


def wait_engine_done(page, expect_plies, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        n = page.evaluate("() => document.querySelectorAll('.movelist li').length")
        busy = page.evaluate("() => !!document.querySelector('.thinking')")
        if n >= expect_plies and not busy:
            return True
        time.sleep(0.6)
    return False


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1500, "height": 950})
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)

    page.goto(URL, wait_until="domcontentloaded", timeout=180_000)
    page.wait_for_selector("rect.hit", timeout=90_000)
    page.get_by_role("button", name="新对局").click()
    page.wait_for_timeout(800)

    taken: list[str] = []
    for i in range(1, 7):
        if not click_next(page, taken):
            print("FAIL: no point available to play")
            sys.exit(1)
        before = len(taken)
        wait_engine_done(page, i * 2)
        played = page.evaluate("() => [...document.querySelectorAll('.movelist li button')].map(b => b.textContent)")
        taken = [t.split('.')[1].split()[0].strip() for t in [x for x in played if x and x[0].isdigit()]]
        if len(taken) <= before:
            print(f"FAIL: move {i} did not land on the record")
            sys.exit(1)
    plies = page.evaluate("() => document.querySelectorAll('.movelist li').length")
    print(f"played 6 moves, board has {plies} plies")

    page.get_by_role("button", name="复盘").click()
    page.get_by_role("button", name="复盘这盘").click()

    try:
        page.wait_for_selector(".audit", timeout=180_000)
    except Exception:
        print("FAIL: no audit line appeared")
        print(page.evaluate("() => document.querySelector('.panel').innerText")[:600])
        sys.exit(1)

    audit_text = page.locator(".audit").inner_text()
    sentences = page.locator(".sent").all_inner_texts()
    headline = [s for s in sentences if "平均每手" in s or "你这盘" in s]
    moves = [s for s in sentences if "亏" in s and "手" in s]
    print(f"audit: {audit_text}")
    print(f"总评句: {headline[:2]}")
    print(f"着法句 {len(moves)} 条，前两条: {moves[:2]}")
    page.screenshot(path=".local/review-panel.png", full_page=True)
    browser.close()

ok = "0 个对不上" in audit_text
print("\n结果:", "PASS — 复盘面板出句且审计全通过" if ok else "FAIL — 有句子引用不到证据")
if errors:
    print("JS 错误:", errors[:6])
sys.exit(0 if ok and not errors else 1)
