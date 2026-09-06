import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

/**
 * Flat config. `eslint-config-next` ships flat configs directly from v16, so
 * there is no need for the FlatCompat shim -- which in fact fails against it.
 */
export default [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'data/**',
      'coverage/**',
      'test-results/**',
      'next-env.d.ts',
      // Vendored from the shadcn registry and kept as generated, so
      // `shadcn add` can update them cleanly.
      'src/components/ui/**',
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      /*
       * Every occurrence in this app reads a browser API on mount -- the clock
       * for the deadline countdown, localStorage for the remembered manager id.
       * Neither can be derived during render without breaking hydration, so the
       * effect is the correct place. Kept as a warning rather than switched off,
       * so a genuinely avoidable one still shows up.
       */
      'react-hooks/set-state-in-effect': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
];
