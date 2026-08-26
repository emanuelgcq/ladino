import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Paquetes puros: sin I/O, sin reloj del sistema. */
const PURE = [
  "packages/core/**",
  "packages/money/**",
  "packages/accounting/**",
  "packages/fiscal/**",
  "packages/inventory/**",
  "packages/schemas/**",
];

/** Paquetes con disciplina financiera dura (ADR-0013). */
const FINANCIAL = [
  "packages/money/**",
  "packages/accounting/**",
  "packages/fiscal/**",
  "packages/inventory/**",
  "packages/domain/**",
];

/** Bundles que llegan al navegador o al teléfono. */
const CLIENT = ["apps/web/**", "apps/mobile/**", "packages/ui/**"];

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/.turbo/**", "**/*.cjs"],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    rules: {
      // ENGINEERING_STANDARDS.md §Lenguaje: sin `any` sin justificar, sin @ts-ignore.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": true,
          "ts-expect-error": "allow-with-description",
          minimumDescriptionLength: 10,
        },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": "warn",
    },
  },

  // ------------------------------------------------------------ disciplina de dinero
  {
    files: FINANCIAL,
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "parseFloat",
          message: "Prohibido en cálculo financiero (ADR-0013). Usa Decimal de @ladino/money.",
        },
        {
          name: "parseInt",
          message:
            "En cálculo financiero usa Decimal. Si es un índice, usa Number.parseInt con comentario.",
        },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "Number",
          property: "parseFloat",
          message: "Prohibido en cálculo financiero (ADR-0013).",
        },
        {
          object: "Math",
          property: "round",
          message:
            "El redondeo monetario es explícito y nombrado: roundForCurrency / roundForTax / roundForDocument / roundForPayment.",
        },
      ],
    },
  },

  // ------------------------------------------------------------------- pureza
  {
    files: PURE,
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message:
            "Nada de Date.now() en dominio puro (ENGINEERING_STANDARDS.md §Fechas). El reloj se inyecta.",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "Nada de new Date() en dominio puro. El reloj se inyecta.",
        },
      ],
    },
  },

  // ---------------------------------------------- fronteras (SOLO feedback en editor)
  // El gate real es dependency-cruiser (ADR-0021), que sí ve la alcanzabilidad transitiva.
  // Estas dos aristas están aquí porque son las que más se violan al escribir, no porque
  // ESLint baste. No añadas aquí reglas que no estén también en .dependency-cruiser.cjs.
  {
    files: CLIENT,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@ladino/fiscal",
                "@ladino/fiscal/*",
                "@ladino/accounting",
                "@ladino/accounting/*",
                "@ladino/domain",
                "@ladino/domain/*",
                "@ladino/inventory",
                "@ladino/inventory/*",
              ],
              message:
                "Cero reglas tributarias ni contables en cliente (CLAUDE.md §7). Consume la API.",
            },
            {
              // La negación es la mitad de la regla: sin ella, el patrón
              // bloqueaba TAMBIÉN /format — y nunca se notó porque ningún
              // cliente había importado money hasta el módulo de productos.
              // Una regla que prohíbe de más es tan tapada como una que
              // prohíbe de menos: la destapó el primer uso legítimo.
              // (Con `group` + negación esta versión de ESLint seguía bloqueando
              // /format; el regex es explícito y se probó en las dos direcciones.)
              regex: "^@ladino/money(?!/format$)",
              message:
                "Desde cliente solo @ladino/money/format. La raíz lleva aritmética y FX (ADR-0021).",
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------- tests
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/test/**"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-restricted-syntax": "off",
      "no-console": "off",
    },
  },

  // Config de herramientas: JS suelto sin type-checking.
  {
    files: ["*.js", "*.mjs", "scripts/**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
