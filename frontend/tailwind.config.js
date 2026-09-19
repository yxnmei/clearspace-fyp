/** @type {import('tailwindcss').Config} */

// ClearSpace design tokens. The source of truth for the actual values is the
// CSS variable block in src/index.css; this file only gives them Tailwind
// names so components can write `bg-primary`, `text-muted-foreground`,
// `rounded-card`, `shadow-card`, `ring-ring`, etc. instead of ad-hoc colours
// and arbitrary values.
//
// These are ADDITIVE: Tailwind's built-in scales (stone-*, green-*,
// rounded-lg, shadow-sm, …) are left untouched so screens not yet migrated
// to the system keep rendering exactly as before.
const withOpacity = (variable) => `hsl(var(${variable}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        background: withOpacity("--background"),
        surface: {
          DEFAULT: withOpacity("--surface"),
          muted: withOpacity("--surface-muted"),
        },
        foreground: withOpacity("--foreground"),
        "muted-foreground": withOpacity("--muted-foreground"),
        border: withOpacity("--border"),
        input: withOpacity("--input"),
        ring: withOpacity("--ring"),
        primary: {
          DEFAULT: withOpacity("--primary"),
          foreground: withOpacity("--primary-foreground"),
          hover: withOpacity("--primary-hover"),
        },
        accent: {
          DEFAULT: withOpacity("--accent"),
          foreground: withOpacity("--accent-foreground"),
        },
        success: {
          DEFAULT: withOpacity("--success"),
          foreground: withOpacity("--success-foreground"),
        },
        warning: {
          DEFAULT: withOpacity("--warning"),
          foreground: withOpacity("--warning-foreground"),
        },
        error: {
          DEFAULT: withOpacity("--error"),
          foreground: withOpacity("--error-foreground"),
        },
        decision: {
          keep: withOpacity("--decision-keep"),
          sell: withOpacity("--decision-sell"),
          donate: withOpacity("--decision-donate"),
          discard: withOpacity("--decision-discard"),
        },
      },
      fontFamily: {
        // Manrope is the primary UI typeface, bundled via @fontsource/manrope
        // (no remote fonts). The rest is a durable system fallback stack.
        sans: [
          "Manrope",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "Noto Sans",
          "sans-serif",
          "Apple Color Emoji",
          "Segoe UI Emoji",
        ],
      },
      fontSize: {
        // Consistent typographic scale (size / line-height).
        "display": ["2.25rem", { lineHeight: "2.5rem", letterSpacing: "-0.02em" }],
        "title": ["1.5rem", { lineHeight: "2rem", letterSpacing: "-0.01em" }],
      },
      borderRadius: {
        card: "var(--radius)",
        control: "calc(var(--radius) - 0.25rem)",
        pill: "9999px",
      },
      boxShadow: {
        card: "0 1px 2px 0 hsl(152 24% 12% / 0.06), 0 1px 3px 0 hsl(152 24% 12% / 0.08)",
        elevated: "0 12px 32px -12px hsl(152 24% 12% / 0.18)",
        "focus-ring": "0 0 0 2px hsl(var(--background)), 0 0 0 4px hsl(var(--ring))",
      },
      maxWidth: {
        content: "72rem",
      },
      spacing: {
        18: "4.5rem",
      },
    },
  },
  plugins: [],
};
