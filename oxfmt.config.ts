import { defineConfig, type OxfmtConfig } from "oxfmt";

export default defineConfig({
  semi: true,
  singleQuote: false,
  tabWidth: 2,
  useTabs: false,
  printWidth: 100,
  endOfLine: "lf",
  trailingComma: "all",
  sortPackageJson: true,
  insertFinalNewline: true,
  sortImports: {
    newlinesBetween: false,
  },
  ignorePatterns: ["spec/**", ".generated-specs/**", "lib/**", "**/*.md", "pnpm-lock.yaml"],
} satisfies OxfmtConfig);
