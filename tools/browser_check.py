"""Real-browser check: does the page hydrate, accept a click, and get an engine reply?
Headless Chromium is a separate browser from the in-app surface, so this proves the app itself.
"""
import sys
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:3100/play"
errors: list[str] = []

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1500, "height": 950})
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type in ("error", "warning") else None)

    page.goto(URL, wait_until="domcontentloaded", timeout=180_000)
    # Hydration shows up as React answering a state change; wait for the board to become clickable.
    try:
        page.wait_for_selector("rect.hit", timeout=60_000)
        hydrated = True
    except Exception:
        hydrated = False
    state = page.evaluate(
        """() => ({
            nextRuntime: !!window.next,
            hits: document.querySelectorAll('rect.hit').length,
            badge: (document.querySelector('.badge')||{}).textContent,
            dot: (document.querySelector('.dot')||{}).className,
            moves: (document.querySelector('.movelist')||{}).innerText || ''
        })"""
    )
    print("hydrated:", hydrated, "|", state)

    if not hydrated:
        print("FAILED: client never hydrated"); print("\n".join(errors[:10])); sys.exit(1)

    # Switch to 学习模式 so we also exercise the engine-data panel.
    page.select_option("select >> nth=0", "learn")
    page.wait_for_timeout(300)
    print("disclaimer visible:", page.locator(".disclaimer").count() > 0)

    # SVG children are namespace-bound, so XPath on <title> misses; locate the hit rect by index instead.
    idx = page.evaluate(
        """() => [...document.querySelectorAll('rect.hit')].findIndex(r => (r.querySelector('title')||{}).textContent === 'D4')"""
    )
    if idx < 0:
        print("FAILED: could not locate the D4 hit target"); sys.exit(1)
    print("D4 hit index:", idx)
    page.locator("rect.hit").nth(idx).click()
    page.wait_for_timeout(500)
    print("after black D4:", page.evaluate("() => document.querySelector('.movelist').innerText").replace("\n", " ")[:90])

    print("waiting for the engine reply (blitz 3+2, ~104 visits)...")
    page.wait_for_function("() => document.querySelectorAll('.movelist li').length >= 2", timeout=120_000)
    print("both moves:", page.evaluate("() => document.querySelector('.movelist').innerText").replace("\n", " ")[:120])
    page.wait_for_timeout(2500)
    panel = page.evaluate("() => (document.querySelector('.panel')||{}).innerText")
    print("engine panel:\n", (panel or "")[:400])
    print("stones on board:", page.evaluate("() => document.querySelectorAll('svg.goban circle').length"))
    page.screenshot(path=".local/browser-check.png", full_page=False)
    print("screenshot: .local/browser-check.png")
    browser.close()

print("\nJS errors/warnings:", "\n".join(errors[:12]) if errors else "none")
