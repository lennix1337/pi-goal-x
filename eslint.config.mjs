import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

// external: ESLint no-unused-vars misidentifies TypeScript interface parameters and re-exports.
export default tseslint.config(
	{ ignores: ["node_modules/**", "experiments/**", "specs/**", "docs/**", ".pi/**", "scratchpad/**"] },
	js.configs.recommended,
	{
		files: ["**/*.ts"],
		plugins: { "@typescript-eslint": tseslint.plugin },
		languageOptions: {
			parser: tseslint.parser,
			ecmaVersion: 2022,
			sourceType: "module",
			globals: globals.node,
		},
		rules: {
			"no-undef": "off",
			"no-unused-vars": "off",
			"no-regex-spaces": "off",
			"no-empty": ["error", { allowEmptyCatch: true }],
		},
	},
	{
		files: ["extensions/**/*.ts"],
		rules: {
			"@typescript-eslint/no-explicit-any": "error",
		},
	},
	{
		files: ["**/*.mjs"],
		languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: globals.node },
		rules: {
			"no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
		},
	},
);
