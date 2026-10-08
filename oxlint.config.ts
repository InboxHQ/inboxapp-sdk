import { defineConfig, type OxlintConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: ["lib/**", "spec/**", ".scripts-types/**"],
  rules: {
    "require-yield": "off",
  },
} satisfies OxlintConfig);
