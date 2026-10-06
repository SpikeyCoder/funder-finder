// Lint gate for the one rule whose violations crash production: a hook after
// an early return (React #310, onboarding 2026-10-05). Kept to rules-of-hooks
// so it can block CI without a codebase-wide style cleanup.
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config({
  files: ['src/**/*.{ts,tsx}'],
  languageOptions: { parser: tseslint.parser },
  // typescript-eslint is registered (no rules on) so existing
  // eslint-disable comments naming its rules still resolve.
  plugins: { 'react-hooks': reactHooks, '@typescript-eslint': tseslint.plugin },
  linterOptions: { reportUnusedDisableDirectives: 'off' },
  rules: { 'react-hooks/rules-of-hooks': 'error' },
});
