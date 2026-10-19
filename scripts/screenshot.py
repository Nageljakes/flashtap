#!/usr/bin/env python3
"""Viewport screenshot helper for the FlashTap demo.

Unlike pw-fetch (full-page), this captures exactly one viewport, which is how
a TV or phone actually renders the game.

usage: screenshot.py URL OUT [--wait MS] [--width W] [--height H]
"""
import argparse
import sys

from playwright.sync_api import sync_playwright


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("path")
    ap.add_argument("--wait", type=int, default=2000)
    ap.add_argument("--width", type=int, default=1600)
    ap.add_argument("--height", type=int, default=900)
    a = ap.parse_args()
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(viewport={"width": a.width, "height": a.height})
        pg = ctx.new_page()
        pg.goto(a.url, timeout=45000)
        pg.wait_for_timeout(a.wait)
        pg.screenshot(path=a.path, full_page=False)
        b.close()


if __name__ == "__main__":
    sys.exit(main())
