import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        app: "var(--app-bg)",
        sidebar: "var(--sidebar-bg)",
        surface: "var(--surface)",
        panel: "var(--panel-bg)",
        ink: "var(--text-primary)",
        secondary: "var(--text-secondary)",
        tertiary: "var(--text-tertiary)",
        line: "var(--border)",
        accent: "var(--accent)",
        success: "var(--success)",
        warning: "var(--warning)",
        danger: "var(--danger)"
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "sans-serif"],
        mono: ["Geist Mono", "SFMono-Regular", "Consolas", "monospace"]
      },
      boxShadow: {
        composer: "0 12px 32px rgba(24, 24, 27, 0.07), 0 1px 2px rgba(24, 24, 27, 0.04)",
        popover: "0 16px 40px rgba(24, 24, 27, 0.11), 0 1px 3px rgba(24, 24, 27, 0.06)"
      }
    }
  },
  plugins: []
};

export default config;
