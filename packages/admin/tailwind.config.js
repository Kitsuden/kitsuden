/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{svelte,js,ts,jsx,tsx}", "./src/**/*.svelte"],
  theme: {
    extend: {
      colors: {
        kitsuden: {
          bg: "rgb(var(--kitsuden-bg) / <alpha-value>)",
          card: "rgb(var(--kitsuden-card) / <alpha-value>)",
          surface: "rgb(var(--kitsuden-surface) / <alpha-value>)",
          border: "rgb(var(--kitsuden-border) / <alpha-value>)",
          muted: "rgb(var(--kitsuden-muted) / <alpha-value>)",
          subtle: "rgb(var(--kitsuden-subtle) / <alpha-value>)",
          text: "rgb(var(--kitsuden-text) / <alpha-value>)",
          "text-dim": "rgb(var(--kitsuden-text-dim) / <alpha-value>)",
          accent: "rgb(var(--kitsuden-accent) / <alpha-value>)",
          "accent-dim": "rgb(var(--kitsuden-accent-dim) / <alpha-value>)",
          "accent-hover": "rgb(var(--kitsuden-accent-hover) / <alpha-value>)",
          "accent-2": "rgb(var(--kitsuden-accent-2) / <alpha-value>)",
          "accent-2-dim": "rgb(var(--kitsuden-accent-2-dim) / <alpha-value>)",
          green: "rgb(var(--kitsuden-green) / <alpha-value>)",
          amber: "rgb(var(--kitsuden-amber) / <alpha-value>)",
          yellow: "rgb(var(--kitsuden-yellow) / <alpha-value>)",
          purple: "rgb(var(--kitsuden-purple) / <alpha-value>)",
          danger: "rgb(var(--kitsuden-danger) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["var(--kitsuden-font-sans)", "Inter", "system-ui", "sans-serif"],
        mono: ["var(--kitsuden-font-mono)", "JetBrains Mono", "Fira Code", "monospace"],
      },
      animation: {
        "glow-pulse": "glow-pulse 2s ease-in-out infinite",
        "slide-in": "slide-in 0.2s ease-out",
        "fade-in": "fade-in 0.15s ease-out",
      },
      keyframes: {
        "glow-pulse": {
          "0%, 100%": { boxShadow: "0 0 5px rgba(0, 229, 255, 0.3)" },
          "50%": { boxShadow: "0 0 20px rgba(0, 229, 255, 0.6)" },
        },
        "slide-in": {
          from: { transform: "translateX(-8px)", opacity: "0" },
          to: { transform: "translateX(0)", opacity: "1" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
      },
    },
  },
  plugins: [],
};

// Trigger HMR 1
