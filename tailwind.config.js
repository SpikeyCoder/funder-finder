/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        gray: {
          // Lightened to pass WCAG AA 4.5:1 on dark background (#0d1117).
          // Light-mode overrides in index.css restore darker values for white backgrounds.
          500: '#9ca3af', // was #6b7280 (~3.8:1), now ~7.5:1
          600: '#8b949e', // was #4b5563 (~2.5:1), now ~6.1:1
        },
      },
    },
  },
  plugins: [],
}
