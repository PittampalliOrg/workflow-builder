#!/usr/bin/env python3
"""In-sandbox screenshot capture. Runs inside the OpenShell sandbox pod."""
import argparse
import base64
import json
import os
import sys

from playwright.sync_api import sync_playwright


def capture(base_url: str, steps: list[dict], output_dir: str) -> None:
    os.makedirs(output_dir, exist_ok=True)
    results: list[dict] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(
            args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
            headless=True,
        )
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        for i, step in enumerate(steps):
            url = step.get("url") or step.get("path") or "/"
            if not url.startswith("http"):
                url = f"{base_url.rstrip('/')}/{url.lstrip('/')}"
            page.goto(url, wait_until="networkidle", timeout=30000)
            if step.get("waitForSelector"):
                page.wait_for_selector(step["waitForSelector"], timeout=15000)
            if step.get("waitForText"):
                page.get_by_text(step["waitForText"]).wait_for(timeout=15000)
            if step.get("delayMs"):
                page.wait_for_timeout(step["delayMs"])
            path = os.path.join(output_dir, f"step-{i + 1}.png")
            page.screenshot(path=path, full_page=True)
            with open(path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode()
            results.append(
                {
                    "step": i + 1,
                    "url": url,
                    "path": path,
                    "base64Length": len(b64),
                }
            )
        browser.close()
    print(json.dumps({"success": True, "screenshots": results}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--steps", required=True)  # JSON string
    parser.add_argument("--output-dir", default="/tmp/screenshots")
    args = parser.parse_args()
    try:
        capture(args.base_url, json.loads(args.steps), args.output_dir)
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}), file=sys.stderr)
        sys.exit(1)
