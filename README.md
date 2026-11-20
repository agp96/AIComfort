# AIComfort

> Navigate between prompts and improve readability on Claude, Gemini & ChatGPT.

![Firefox](https://img.shields.io/badge/Firefox-140%2B-orange?logo=firefox)
![Manifest](https://img.shields.io/badge/Manifest-v3-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## Overview

AIComfort is a Firefox extension that adds an isolated side panel to Claude.ai, ChatGPT and Gemini. It lets you jump instantly between your prompts in long conversations and customize the reading experience to reduce eye strain, automatically matching each site's light or dark theme.

## Features

### Prompt Navigation
- Side panel listing all your prompts, numbered and clickable
- Automatic sync when switching conversations or editing prompts
- Keyboard shortcuts **Alt + ↑ / ↓** to move between prompts (paused automatically while editing text)
- Active prompt highlighted in the panel
- Collapsible panel (`»` button in the header and floating `☰` button when hidden) with remembered open/closed state
- Go to top / Go to bottom buttons

### Accessibility Settings
- **Font size** — scale text size from 80% to 140%
- **High contrast** — boost conversation contrast for better readability
- **Sepia mode** — warm tone overlay to reduce eye strain
- **Line height** — smoothly increase spacing between lines
- **Column width** — narrow or widen the conversation column
- **Align left** — shift the conversation to the left side

All settings are saved locally per site and persist across sessions.

## Supported Sites

| Site | URL |
|------|-----|
| Claude | claude.ai |
| ChatGPT | chatgpt.com |
| Gemini | gemini.google.com |

## Installation

### From Firefox Add-ons (recommended)
Install directly from the [Firefox Add-ons page](https://addons.mozilla.org/firefox/addon/aicomfort/).

### Manual installation
1. Clone or download this repository
2. Open Firefox and go to `about:debugging`
3. Click **This Firefox** → **Load Temporary Add-on**
4. Select the `manifest.json` file

## Project Structure

aicomfort/
├── manifest.json
├── content.js
├── styles.css
├── README.md
├── LICENSE
└── icons/
├── icon16.png
├── icon48.png
└── icon128.png


## Privacy

AIComfort requests zero browser permissions and does not collect, store, or transmit any personal data. All settings are stored locally per site in your browser via `localStorage` and never leave your device. No external requests are made.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt + ↑` | Previous prompt |
| `Alt + ↓` | Next prompt |

## License

MIT License — see [LICENSE](LICENSE) for details.