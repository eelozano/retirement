import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Recharts measures its container; jsdom has no ResizeObserver to measure
// with. A chart renders at zero width, which is all a test needs — the
// assertions are about what was called or shown, not what was drawn.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// jsdom has no layout engine behind <dialog>, so showModal()/close() are
// unimplemented rather than no-ops — Modal calls them unconditionally.
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
};

afterEach(() => {
  cleanup();
});
