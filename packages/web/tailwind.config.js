/**
 * The design tokens.
 *
 * The surface colours are CSS variables so one `html.dark` class switches the
 * whole app; the brand and data colours are fixed hex, because they were chosen
 * against contrast and colour-blindness checks and must not drift per theme.
 *
 * Do not lighten `accent`: white text on #5C5FC8 is 5.68:1, and anything
 * lighter fails. Do not dim `ink2`: it is the floor that keeps small labels
 * readable in both themes.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        accent: { DEFAULT: '#5C5FC8', soft: '#A9ACF0', ink: '#4B4EB5' },
        // For marks only — dots, bars, rings. Text beside them stays ink/ink2.
        data: { blue: '#1C9ED9', pink: '#E35C9A', amber: '#D97706', green: '#0E9C63' },
        bad: { DEFAULT: '#D1476A', soft: '#F0A2B6', ink: '#A82850' },
        page: 'rgb(var(--page) / <alpha-value>)',
        side: 'rgb(var(--side) / <alpha-value>)',
        card: 'rgb(var(--card) / <alpha-value>)',
        raise: 'rgb(var(--raise) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        ink2: 'rgb(var(--ink2) / <alpha-value>)',
      },
      borderRadius: { card: '24px', inner: '18px', ctl: '16px' },
      boxShadow: { card: 'var(--card-shadow)' },
      keyframes: {
        pulsedot: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.35' } },
        risein: { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: { pulsedot: 'pulsedot 1.4s ease-in-out infinite', risein: 'risein .22s ease-out both' },
    },
  },
  plugins: [],
}
