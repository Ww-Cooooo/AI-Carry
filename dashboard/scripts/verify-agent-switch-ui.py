import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
URL = os.environ.get("AI_CARRY_PREVIEW_URL", "http://127.0.0.1:4173/index.html#transfer")
SCREENSHOT = ROOT / ".." / ".." / "maintainer-private" / "validation" / "agent-switch-20260922.png"
SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    errors = []
    page.on("console", lambda message: errors.append(f"console:{message.type}:{message.text}") if message.type == "error" else None)
    page.on("pageerror", lambda error: errors.append(f"pageerror:{error}"))
    page.goto(URL, wait_until="networkidle")
    page.get_by_role("button", name="换一个 Agent").click()
    assert page.get_by_role("heading", name="先做一份独立副本").is_visible()
    assert page.get_by_role("button", name="预览独立副本请求").is_visible()
    page.get_by_role("button", name="共用原目录").click()
    assert page.get_by_role("heading", name="轮流共用原目录").is_visible()
    assert page.get_by_role("button", name="预览共用接入请求").is_visible()
    page.screenshot(path=str(SCREENSHOT), full_page=True)
    assert page.locator("body").evaluate("el => el.scrollWidth <= el.clientWidth"), "horizontal overflow"
    assert not errors, errors
    browser.close()
print(f"Agent switch UI passed at {URL}; screenshot={SCREENSHOT}")
