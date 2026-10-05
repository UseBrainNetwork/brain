"use client";

import { useEffect } from "react";

const SELECTOR = ".display, .display-md";

/**
 * Marks headings with data-in once they enter the viewport; CSS in globals.css runs the reveal.
 * Uses rects rather than IntersectionObserver: the masked heading's own clip-path makes it
 * report as non-intersecting.
 */
export function RevealObserver() {
  useEffect(() => {
    let raf = 0;
    const check = () => {
      raf = 0;
      const limit = window.innerHeight * 0.94;
      document.querySelectorAll<HTMLElement>(`:is(${SELECTOR}):not([data-in])`).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.top < limit && r.bottom > 0 && r.width > 0) el.setAttribute("data-in", "");
      });
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };
    check();
    const mo = new MutationObserver(on);
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
      window.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
    };
  }, []);
  return null;
}
