import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules', 'out', 'dist', '.vite', 'coverage'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: { ...globals.browser, ...globals.node, ...globals.es2023 },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    settings: {
      react: { version: '18.3' },
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      // TypeScript performs its own undefined-symbol checking; core no-undef
      // does not understand TS globals like `JSX` and is redundant here.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Encapsulation invariant (remote-transport-abstraction): `ssh2` and
    // `@types/ssh2` are imported by exactly ONE file — the Ssh2Transport
    // implementation. All other remote code depends on the RemoteTransport
    // interface. Ban the import everywhere, then re-allow it only in
    // transport.ts below. Note: this rule does not catch inline `import('ssh2')`
    // type expressions, which are allowed only inside the impl file.
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'ssh2',
              message:
                'Import the RemoteTransport interface instead; ssh2 may only be used by Ssh2Transport (transport.ts).',
            },
            {
              name: '@types/ssh2',
              message:
                'Import the RemoteTransport interface instead; @types/ssh2 may only be used by Ssh2Transport (transport.ts).',
            },
          ],
        },
      ],
    },
  },
  {
    // The single permitted ssh2 import site.
    files: ['electron/main/providers/remote/transport.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['**/*.cjs', '**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
