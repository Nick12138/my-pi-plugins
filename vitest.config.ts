import { defineConfig } from "vitest/config";

// vitest 只接管新式测试（本仓库 4 个外移插件的用例）。
// 旧插件（pi-todo / pi-vision 等）的 tests/*.test.ts 是可独立 `node` 执行的
// 裸断言脚本，不属于 vitest 范围，保持原样、不在此 include。
export default defineConfig({
  test: {
    include: [
      "packages/pi-ask-user-question/**/*.test.ts",
      "packages/piabyss-memo/**/*.test.ts",
      "packages/piabyss-present-files/**/*.test.ts",
      "packages/pi-pixie/**/*.test.ts",
      "packages/pi-reimburse/**/*.test.ts",
    ],
    environment: "node",
  },
});
