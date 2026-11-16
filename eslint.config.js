// Contrôle du code : npm run lint (aussi lancé par npm run check).
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['public/vendor/**', 'data/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    rules: {
      eqeqeq: 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  { files: ['server/**', 'test/**', 'tools/**', '*.js'], languageOptions: { globals: globals.node } },
  { files: ['public/js/**'], languageOptions: { globals: globals.browser } },
  { files: ['public/sw.js'], languageOptions: { globals: globals.serviceworker } },
];
