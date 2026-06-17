import "@testing-library/jest-dom";
import { vi } from "vitest";

Object.defineProperty(window, "bfd", {
  configurable: true,
  value: {
    startORPCServer: vi.fn(),
  },
});
