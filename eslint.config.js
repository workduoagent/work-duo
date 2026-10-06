// F018：ESLint 基建（平面配置）。定位是「关键路径回归门禁」而非全量风格审查——
// 首批硬门禁只保留 rules-of-hooks（hooks 误用是运行时事故）；风格类/存量债务类
// 规则以 warn 记录不阻断，后续分批治理（F036-F052 范畴）。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'src-tauri/**',
      '.workspace/**',
      'node_modules/**',
      'docs/**',
      '*.config.js',
      '*.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // —— 硬门禁（error，阻断 lint）——
      'react-hooks/rules-of-hooks': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // —— 存量债务观察项（warn 不阻断，分批治理后升级）——
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
)
