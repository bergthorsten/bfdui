import "@testing-library/jest-dom";
import { vi } from "vitest";

Object.defineProperty(window, "bfd", {
  configurable: true,
  value: {
    startORPCServer: vi.fn(),
  },
});

class TestResizeObserver {
  disconnect = vi.fn();
  observe = vi.fn();
  unobserve = vi.fn();
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: TestResizeObserver,
});
