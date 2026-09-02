import type { Config } from 'tailwindcss';

/**
 * Bhagyoday Belts ERP - design tokens.
 * Cool neutral shell, charcoal text, one restrained slate-blue accent.
 * Colour is reserved for status; it is never decoration.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#EEF1F5',
        surface: '#FFFFFF',
        raised: '#F7F9FB',
        line: '#DCE3EA',
        'line-strong': '#C3CEDA',
        ink: '#182430',
        'ink-2': '#4E5C6B',
        'ink-3': '#7C8896',
        accent: '#1F4E79',
        'accent-hover': '#173C5E',
        'accent-soft': '#E7EFF7',
        ok: '#166E3F',
        'ok-soft': '#E7F3EC',
        warn: '#8A5A00',
        'warn-soft': '#FBF1DF',
        danger: '#A32017',
        'danger-soft': '#FAEAE8',
        teal: '#0F6E75',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['11px', '15px'],
        xs: ['12px', '17px'],
        sm: ['13px', '19px'],
        base: ['14px', '21px'],
      },
      borderRadius: {
        none: '0',
        sm: '2px',
        DEFAULT: '3px',
        md: '4px',
        lg: '6px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(24, 36, 48, 0.05)',
        panel: '-8px 0 24px rgba(24, 36, 48, 0.10)',
        modal: '0 12px 32px rgba(24, 36, 48, 0.18)',
      },
      spacing: {
        sidebar: '212px',
        topbar: '48px',
      },
    },
  },
  plugins: [],
};

export default config;
