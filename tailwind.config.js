/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        base: '#FBF7EC',
        surface: '#FFFFFF',
        ink: '#2F2A1E',
        muted: '#8B8268',
        line: '#E9E1CB',
        primary: {
          DEFAULT: '#2F8145',
          light: '#DEEFDF',
          dark: '#1F5C31'
        },
        warn: {
          DEFAULT: '#E0961F',
          light: '#FBEBCF'
        },
        danger: {
          DEFAULT: '#D6472A',
          light: '#FBE3DC'
        },
        accent: {
          DEFAULT: '#7C4A93',
          light: '#F0E4F5',
          dark: '#5C3670'
        }
      },
      borderRadius: {
        xl: '1rem',
        '2xl': '1.5rem'
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Fredoka', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace']
      }
    }
  },
  plugins: []
}
