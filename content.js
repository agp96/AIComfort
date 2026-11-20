/* ============================================================
   AIComfort – Content Script
   Enhanced navigation for Claude · ChatGPT · Gemini
   ============================================================ */

(() => {
  'use strict';

  if (document.getElementById('aicomfort-host')) return;

  // ─── Site detection and selectors ──────────────────────────
  const SITE_CONFIG = {
    claude: {
      host: 'claude.ai',
      selectors: ["div[data-testid='user-message']"],
      containerSelector: '#main-content',
      scrollContainerSelectors: [
        '[class*="ThreadLayout"]',
        '[class*="thread"]',
        'main [class*="scroll"]',
        'main',
      ],
      widerSelectors: [
        '#main-content',
        '#main-content > div',
        '#main-content [class*="max-w-"]',
      ],
      fontScaleMode: 'root',
    },
    chatgpt: {
      host: 'chatgpt.com',
      selectors: [
        "div[data-message-author-role='user']",
        'div.user-message-bubble-color',
      ],
      containerSelector: 'main',
      scrollContainerSelectors: [
        '[class*="react-scroll-to-bottom"] > div',
        'main [role="presentation"]',
        'main div[class*="overflow-y"]',
        'main',
      ],
      widerSelectors: [
        'main',
        'main > div',
        'main [class*="max-w-"]',
        'main article > div',
      ],
      fontScaleMode: 'root',
    },
    gemini: {
      host: 'gemini.google.com',
      selectors: [
        "div.query-text[role='heading']",
        'user-query .query-text',
      ],
      containerSelector: '.content-container',
      scrollContainerSelectors: [
        '.conversation-container',
        'main [class*="scroll"]',
        'main',
      ],
      widerSelectors: [
        '.content-container',
        '.conversation-container',
        'user-query',
        'model-response',
        '.response-container',
      ],
      fontScaleMode: 'zoom',
      zoomSelectors: ['user-query', 'model-response'],
    },
  };

  function detectSite() {
    const host = location.hostname;
    for (const [key, cfg] of Object.entries(SITE_CONFIG)) {
      if (host.includes(cfg.host)) return { name: key, ...cfg };
    }
    return null;
  }

  const site = detectSite();
  if (!site) return;

  // ─── Constants ─────────────────────────────────────────────
  const STORAGE_KEY = 'aicomfort-settings';
  const PANEL_STATE_KEY = 'aicomfort-panel-open';
  const CHECK_INTERVAL = 250;
  const DEFAULTS = {
    highContrast: false,
    fontSize: 0,          // delta: -4 … +8 (5% per step -> 80% … 140%)
    sepiaMode: false,
    lineHeight: 0,        // 0 = default, up to 1.0 (1.5 … 2.3)
    columnWidth: 0,       // -1 = wider … 0 = default … 5 = narrower
    alignLeft: false,     // shift conversation to the left
  };

  // ─── State ─────────────────────────────────────────────────
  let panelOpen = true;
  let settingsOpen = false;
  let currentIndex = -1;
  let selectedMessageEl = null;
  let selectedMessageKey = null;
  let userMessages = [];
  let settings = { ...DEFAULTS };
  let lastUrl = location.href;
  let lastMessageSignature = '';
  let cachedScrollContainer = null;
  let lastCheckTime = 0;
  let pendingTimer = null;

  // ─── Persistence ───────────────────────────────────────────
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Migration: readingMode → sepiaMode
        if ('readingMode' in parsed && !('sepiaMode' in parsed)) {
          parsed.sepiaMode = parsed.readingMode;
          delete parsed.readingMode;
        }
        settings = { ...DEFAULTS, ...parsed };
      }
    } catch (_) { /* ignore */ }

    try {
      const savedPanel = localStorage.getItem(PANEL_STATE_KEY);
      if (savedPanel !== null) {
        panelOpen = savedPanel === 'true';
      }
    } catch (_) { /* ignore */ }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (_) { /* ignore */ }
  }

  function savePanelState() {
    try {
      localStorage.setItem(PANEL_STATE_KEY, String(panelOpen));
    } catch (_) { /* ignore */ }
  }

  // ─── DOM helper (no innerHTML) ─────────────────────────────
  function createEl(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [key, val] of Object.entries(attrs)) {
      if (val == null) continue;
      if (key === 'className') {
        el.className = val;
      } else if (key === 'textContent') {
        el.textContent = val;
      } else if (key.startsWith('on') && typeof val === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), val);
      } else {
        el.setAttribute(key, String(val));
      }
    }
    for (const child of children) {
      if (child == null) continue;
      el.appendChild(
        typeof child === 'string' ? document.createTextNode(child) : child
      );
    }
    return el;
  }

  // ─── Utilities ─────────────────────────────────────────────
  function extractPromptText(el) {
    const clone = el.cloneNode(true);
    clone
      .querySelectorAll('.cdk-visually-hidden, .sr-only, [aria-hidden="true"]')
      .forEach((node) => node.remove());
    return clone.textContent || el.textContent || '';
  }

  function truncate(text, max = 90) {
    let clean = text.replace(/\s+/g, ' ').trim();
    clean = clean.replace(/^(Has dicho|You said)\s*/i, '');
    return clean.length > max ? clean.slice(0, max) + '…' : clean;
  }

  function announce(msg) {
    const el = document.getElementById('aicomfort-live');
    if (el) {
      el.textContent = '';
      requestAnimationFrame(() => { el.textContent = msg; });
    }
  }

  function getUserMessages() {
    for (const sel of site.selectors) {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) return Array.from(found);
    }
    return [];
  }

  /** Lightweight signature without DOM cloning */
  function getMessageSignature(msgs) {
    return msgs
      .map((m) => (m.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90))
      .join('\u0000');
  }

  /**
   * Finds the scrollable container of the conversation without full-DOM scans.
   */
  function getScrollContainer() {
    if (
      cachedScrollContainer &&
      cachedScrollContainer.isConnected &&
      cachedScrollContainer.scrollHeight > cachedScrollContainer.clientHeight + 10
    ) {
      return cachedScrollContainer;
    }

    for (const sel of site.scrollContainerSelectors) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight + 10) {
        cachedScrollContainer = el;
        return el;
      }
    }

    const msgs = userMessages.length > 0 ? userMessages : getUserMessages();
    if (msgs.length > 0) {
      let node = msgs[0].parentElement;
      while (node && node !== document.body && node !== document.documentElement) {
        const ov = getComputedStyle(node).overflowY;
        if ((ov === 'auto' || ov === 'scroll') && node.scrollHeight > node.clientHeight + 20) {
          cachedScrollContainer = node;
          return node;
        }
        node = node.parentElement;
      }
    }

    if (document.documentElement.scrollHeight > document.documentElement.clientHeight + 10) {
      return document.documentElement;
    }

    return null;
  }

  function doScrollTop() {
    const c = getScrollContainer();
    if (c) c.scrollTo({ top: 0, behavior: 'smooth' });
    if (c !== document.documentElement && c !== document.body) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function doScrollBottom() {
    const c = getScrollContainer();
    if (c) c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
    if (c !== document.documentElement && c !== document.body) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    }
  }

  function scrollToElement(el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('ac-highlight');
    void el.offsetWidth;
    el.classList.add('ac-highlight');
    setTimeout(() => el.classList.remove('ac-highlight'), 900);
  }

  // ─── Theme detection (matches actual site theme) ───────────
  function parseRgb(color) {
    const match = color?.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)/);
    if (!match) return null;
    const alpha = match[4] !== undefined ? parseFloat(match[4]) : 1;
    if (alpha === 0) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }

  function detectPageTheme() {
    const candidates = [
      document.querySelector(site.containerSelector),
      document.body,
      document.documentElement,
    ];
    for (const el of candidates) {
      if (!el) continue;
      const rgb = parseRgb(getComputedStyle(el).backgroundColor);
      if (rgb) {
        const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
        return lum > 0.55 ? 'light' : 'dark';
      }
    }
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function syncTheme() {
    requestAnimationFrame(() => {
      host.dataset.theme = detectPageTheme();
    });
  }

  // ─── Static page styles (highlight, screen-reader, sepia) ─
  function injectPageBaseStyles() {
    if (document.getElementById('aicomfort-page-styles')) return;
    const style = document.createElement('style');
    style.id = 'aicomfort-page-styles';
    style.textContent = `
      .ac-sr-only {
        position: absolute !important;
        width: 1px !important;
        height: 1px !important;
        padding: 0 !important;
        margin: -1px !important;
        overflow: hidden !important;
        clip: rect(0, 0, 0, 0) !important;
        white-space: nowrap !important;
        border: 0 !important;
      }
      #aicomfort-sepia-overlay {
        position: fixed !important;
        inset: 0 !important;
        pointer-events: none !important;
        z-index: 2147483639 !important;
        background: rgba(242, 206, 140, 0.28) !important;
        mix-blend-mode: multiply !important;
      }
      @keyframes ac-flash {
        0%   { box-shadow: 0 0 0 0 rgba(124, 92, 252, 0.50); }
        50%  { box-shadow: 0 0 0 6px rgba(124, 92, 252, 0.18); }
        100% { box-shadow: 0 0 0 0 rgba(124, 92, 252, 0); }
      }
      .ac-highlight {
        animation: ac-flash 0.8s ease-out;
        border-radius: 8px;
      }
    `;
    document.head.appendChild(style);
  }

  function syncSepiaOverlay() {
    let overlay = document.getElementById('aicomfort-sepia-overlay');
    if (settings.sepiaMode) {
      if (!overlay) {
        overlay = createEl('div', {
          id: 'aicomfort-sepia-overlay',
          'aria-hidden': 'true',
        });
        document.body.appendChild(overlay);
      }
    } else if (overlay) {
      overlay.remove();
    }
  }

  // ─── Dynamic accessibility styles ─────────────────────────
  let dynamicStyle = null;
  function applyAccessibilityStyles() {
    if (!dynamicStyle) {
      dynamicStyle = document.createElement('style');
      dynamicStyle.id = 'aicomfort-dynamic-styles';
      document.head.appendChild(dynamicStyle);
    }

    syncSepiaOverlay();

    let scrollContainer = null;
    let savedScrollRatio = 0;
    try {
      scrollContainer = getScrollContainer();
      if (scrollContainer) {
        const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
        savedScrollRatio = maxScroll > 0 ? scrollContainer.scrollTop / maxScroll : 0;
      }
    } catch (_) { /* ignore */ }

    const rules = [];
    const containerSel = site.containerSelector || 'main';

    // ── High contrast (scoped to conversation container to preserve fixed elements) ──
    if (settings.highContrast) {
      rules.push(`
        ${containerSel} {
          filter: contrast(1.35) !important;
        }
      `);
    }

    // ── Font size ──
    if (settings.fontSize !== 0) {
      const pct = 100 + settings.fontSize * 5;
      if (site.fontScaleMode === 'zoom' && site.zoomSelectors) {
        const scale = (pct / 100).toFixed(2);
        rules.push(`
          ${site.zoomSelectors.join(',\n          ')} {
            zoom: ${scale} !important;
          }
        `);
      } else {
        rules.push(`html { font-size: ${pct}% !important; }`);
      }
    }

    // ── Line height (smooth scale 1.54 … 2.30, scoped to text elements) ──
    if (settings.lineHeight > 0) {
      const lh = (1.5 + settings.lineHeight * 0.8).toFixed(2);
      const textSelectors = [
        `${containerSel} p`,
        `${containerSel} li`,
        `${containerSel} dd`,
        `${containerSel} blockquote`,
        `${containerSel} .markdown`,
        `${containerSel} .prose`,
        ...site.selectors,
      ];
      rules.push(`
        ${textSelectors.join(',\n        ')} {
          line-height: ${lh} !important;
        }
      `);
    }

    // ── Column width ──
    if (settings.columnWidth > 0) {
      const maxW = Math.max(920 - settings.columnWidth * 40, 720);
      rules.push(`
        ${containerSel},
        ${containerSel} > div {
          max-width: ${maxW}px !important;
          margin-left: auto !important;
          margin-right: auto !important;
        }
      `);
    } else if (settings.columnWidth < 0) {
      rules.push(`
        ${site.widerSelectors.join(',\n        ')} {
          max-width: 100% !important;
        }
      `);
    }

    // ── Align conversation to the left ──
    if (settings.alignLeft) {
      rules.push(`
        ${containerSel},
        ${containerSel} > div,
        ${containerSel} > div > div,
        ${containerSel} > div > div > div {
          align-items: flex-start !important;
          justify-items: start !important;
        }
        ${containerSel} > div,
        ${containerSel} > div > div {
          margin-left: 0 !important;
          margin-right: auto !important;
        }
      `);
    }

    dynamicStyle.textContent = rules.join('\n');

    if (scrollContainer) {
      requestAnimationFrame(() => {
        const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
        if (maxScroll > 0) {
          scrollContainer.scrollTop = savedScrollRatio * maxScroll;
        }
      });
    }
  }

  // ─── Shadow DOM host & UI construction ────────────────────
  const host = createEl('div', { id: 'aicomfort-host' });
  host.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });

  let revealTimer = null;
  function revealHost() {
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    host.style.cssText = '';
  }

  const cssUrl = browser?.runtime?.getURL?.('styles.css');
  if (cssUrl) {
    shadow.appendChild(
      createEl('link', {
        rel: 'stylesheet',
        href: cssUrl,
        onLoad: revealHost,
        onError: revealHost,
      })
    );
    revealTimer = setTimeout(revealHost, 300);
  } else {
    revealHost();
  }

  function createEmptyState() {
    return createEl('div', { className: 'ac-empty-state' }, [
      createEl('span', { className: 'ac-empty-icon', 'aria-hidden': 'true', textContent: '💬' }),
      createEl('span', { className: 'ac-empty-text' }, [
        'No prompts yet.',
        createEl('br'),
        'Send a message to get started.',
      ]),
    ]);
  }

  function createToggleRow(labelId, btnId, labelText, settingKey) {
    const label = createEl('label', {
      className: 'ac-setting-label ac-clickable-label',
      id: labelId,
      for: btnId,
      textContent: labelText,
    });
    const toggleBtn = createEl(
      'button',
      {
        className: 'ac-toggle-btn',
        id: btnId,
        type: 'button',
        role: 'switch',
        'aria-checked': 'false',
        'aria-labelledby': labelId,
        onClick: () => {
          settings[settingKey] = !settings[settingKey];
          const on = settings[settingKey];
          toggleBtn.setAttribute('aria-checked', String(on));
          toggleBtn.classList.toggle('ac-on', on);
          applyAndSave();
          announce(`${labelText}: ${on ? 'on' : 'off'}`);
        },
      },
      [
        createEl('span', { className: 'ac-toggle-track' }, [
          createEl('span', { className: 'ac-toggle-thumb' }),
        ]),
      ]
    );
    return createEl('div', { className: 'ac-setting-row' }, [label, toggleBtn]);
  }

  function buildSettingsView() {
    const scrollGroup = createEl('div', { className: 'ac-setting-group ac-scroll-group' }, [
      createEl('button', {
        className: 'ac-setting-btn ac-scroll-nav-btn',
        id: 'ac-btn-scroll-top',
        type: 'button',
        'aria-label': 'Scroll to top of conversation',
        textContent: '⬆ Go to top',
        onClick: () => {
          doScrollTop();
          announce('Scrolled to top');
        },
      }),
      createEl('button', {
        className: 'ac-setting-btn ac-scroll-nav-btn',
        id: 'ac-btn-scroll-bottom',
        type: 'button',
        'aria-label': 'Scroll to bottom of conversation',
        textContent: '⬇ Go to bottom',
        onClick: () => {
          doScrollBottom();
          announce('Scrolled to bottom');
        },
      }),
    ]);

    const fontSizeRow = createEl('div', { className: 'ac-setting-row' }, [
      createEl('span', {
        className: 'ac-setting-label',
        id: 'ac-label-fs',
        textContent: 'Font size',
      }),
      createEl('div', { className: 'ac-stepper' }, [
        createEl('button', {
          className: 'ac-stepper-btn',
          id: 'ac-fs-minus',
          type: 'button',
          'aria-label': 'Decrease font size',
          textContent: '−',
          onClick: () => {
            settings.fontSize = Math.max(settings.fontSize - 1, -4);
            updateFSDisplay();
            applyAndSave();
            announce(`Font size: ${100 + settings.fontSize * 5}%`);
          },
        }),
        createEl('span', {
          className: 'ac-stepper-value',
          id: 'ac-fs-value',
          'aria-live': 'polite',
          textContent: '100%',
        }),
        createEl('button', {
          className: 'ac-stepper-btn',
          id: 'ac-fs-plus',
          type: 'button',
          'aria-label': 'Increase font size',
          textContent: '+',
          onClick: () => {
            settings.fontSize = Math.min(settings.fontSize + 1, 8);
            updateFSDisplay();
            applyAndSave();
            announce(`Font size: ${100 + settings.fontSize * 5}%`);
          },
        }),
      ]),
    ]);

    const lhSlider = createEl('input', {
      type: 'range',
      id: 'ac-slider-lh',
      className: 'ac-slider',
      min: '0',
      max: '100',
      value: '0',
      step: '5',
      onInput: (e) => {
        settings.lineHeight = parseFloat(e.target.value) / 100;
        applyAndSave();
      },
      onChange: () => {
        announce(`Line height: ${Math.round(settings.lineHeight * 100)}%`);
      },
    });
    const lhRow = createEl('div', { className: 'ac-setting-row ac-setting-row-col' }, [
      createEl('label', {
        className: 'ac-setting-label',
        for: 'ac-slider-lh',
        textContent: 'Line height',
      }),
      lhSlider,
    ]);

    const cwSlider = createEl('input', {
      type: 'range',
      id: 'ac-slider-cw',
      className: 'ac-slider',
      min: '-1',
      max: '5',
      value: '0',
      step: '1',
      onInput: (e) => {
        settings.columnWidth = parseInt(e.target.value, 10);
        updateCWHint();
        applyAndSave();
      },
      onChange: () => {
        const hint = shadow.getElementById('ac-cw-hint');
        announce(`Column width: ${hint ? hint.textContent : settings.columnWidth}`);
      },
    });
    const cwRow = createEl('div', { className: 'ac-setting-row ac-setting-row-col' }, [
      createEl('div', { className: 'ac-slider-label-row' }, [
        createEl('label', {
          className: 'ac-setting-label',
          for: 'ac-slider-cw',
          textContent: 'Column width',
        }),
        createEl('span', {
          className: 'ac-slider-hint',
          id: 'ac-cw-hint',
          textContent: 'Normal',
        }),
      ]),
      cwSlider,
    ]);

    const resetGroup = createEl('div', { className: 'ac-setting-group' }, [
      createEl('button', {
        className: 'ac-setting-btn ac-reset-btn',
        id: 'ac-btn-reset',
        type: 'button',
        'aria-label': 'Reset all settings to default values',
        textContent: '↺ Reset settings',
        onClick: () => {
          settings = { ...DEFAULTS };
          syncSettingsUI();
          applyAndSave();
          announce('Settings reset');
        },
      }),
    ]);

    const scrollContainer = createEl('div', { className: 'ac-settings-scroll' }, [
      scrollGroup,
      createEl('hr', { className: 'ac-divider' }),
      createToggleRow('ac-label-hc', 'ac-toggle-hc', 'High contrast', 'highContrast'),
      fontSizeRow,
      createToggleRow('ac-label-sp', 'ac-toggle-sp', 'Sepia mode', 'sepiaMode'),
      lhRow,
      cwRow,
      createToggleRow('ac-label-al', 'ac-toggle-al', 'Align left', 'alignLeft'),
      resetGroup,
    ]);

    return createEl(
      'div',
      {
        id: 'aicomfort-settings-view',
        className: 'ac-view-hidden',
        role: 'region',
        'aria-label': 'Accessibility settings',
      },
      [scrollContainer]
    );
  }

  function buildPanel() {
    // Header: [⚙]  [AIComfort / badge]  [»]
    const settingsBtn = createEl('button', {
      id: 'aicomfort-settings-btn',
      className: 'ac-icon-btn',
      type: 'button',
      'aria-label': 'Open accessibility settings',
      'aria-pressed': 'false',
      title: 'Settings',
      textContent: '⚙',
      onClick: toggleSettings,
    });

    const headerCenter = createEl('div', { className: 'ac-header-center' }, [
      createEl('h2', { textContent: 'AIComfort' }),
      createEl('span', { id: 'aicomfort-badge', textContent: '0 prompts' }),
    ]);

    const collapseBtn = createEl('button', {
      id: 'aicomfort-collapse-btn',
      className: 'ac-icon-btn',
      type: 'button',
      title: 'Hide panel',
      'aria-label': 'Hide the AIComfort panel',
      textContent: '»',
      onClick: togglePanel,
    });

    const header = createEl('div', { id: 'aicomfort-header' }, [
      settingsBtn,
      headerCenter,
      collapseBtn,
    ]);

    const list = createEl(
      'div',
      {
        id: 'aicomfort-list',
        role: 'list',
        'aria-label': 'User prompt list',
      },
      [createEmptyState()]
    );

    const footer = createEl('div', { id: 'aicomfort-footer' }, [
      createEl('div', { className: 'ac-shortcut-hint' }, [
        createEl('span', { className: 'ac-kbd', textContent: 'Alt' }),
        '+',
        createEl('span', { className: 'ac-kbd', textContent: '↑' }),
        '/',
        createEl('span', { className: 'ac-kbd', textContent: '↓' }),
        ' Jump between prompts',
      ]),
    ]);

    const promptsView = createEl('div', { id: 'aicomfort-prompts-view' }, [
      list,
      footer,
    ]);

    const settingsView = buildSettingsView();

    const panelEl = createEl(
      'div',
      {
        id: 'aicomfort-panel',
        role: 'complementary',
        'aria-label': 'AIComfort – Navigation and accessibility settings panel',
      },
      [header, promptsView, settingsView]
    );

    const live = createEl('div', {
      id: 'aicomfort-live',
      'aria-live': 'polite',
      'aria-atomic': 'true',
      className: 'ac-sr-only',
    });
    document.body.appendChild(live);

    shadow.appendChild(panelEl);
    return panelEl;
  }

  function buildFloatingToggle() {
    const btn = createEl('button', {
      id: 'aicomfort-toggle',
      type: 'button',
      title: 'Show AIComfort panel',
      'aria-label': 'Show the AIComfort panel',
      textContent: '☰',
      onClick: togglePanel,
    });
    shadow.appendChild(btn);
    return btn;
  }

  // ─── Settings helpers ──────────────────────────────────────
  function applyAndSave() {
    applyAccessibilityStyles();
    saveSettings();
  }

  function updateFSDisplay() {
    const el = shadow.getElementById('ac-fs-value');
    if (el) {
      el.textContent = `${100 + settings.fontSize * 5}%`;
    }
  }

  function updateCWHint() {
    const hint = shadow.getElementById('ac-cw-hint');
    if (!hint) return;
    const v = settings.columnWidth;
    if (v < 0) hint.textContent = 'Wider';
    else if (v === 0) hint.textContent = 'Normal';
    else hint.textContent = 'Narrower';
  }

  function syncToggle(id, on) {
    const btn = shadow.getElementById(id);
    if (!btn) return;
    btn.setAttribute('aria-checked', String(on));
    btn.classList.toggle('ac-on', on);
  }

  function syncSettingsUI() {
    syncToggle('ac-toggle-hc', settings.highContrast);
    syncToggle('ac-toggle-sp', settings.sepiaMode);
    syncToggle('ac-toggle-al', settings.alignLeft);
    updateFSDisplay();

    const lh = shadow.getElementById('ac-slider-lh');
    if (lh) lh.value = Math.round(settings.lineHeight * 100);

    const cw = shadow.getElementById('ac-slider-cw');
    if (cw) cw.value = settings.columnWidth;

    updateCWHint();
  }

  // ─── View & Panel toggles ─────────────────────────────────
  function toggleSettings() {
    settingsOpen = !settingsOpen;
    const pv = shadow.getElementById('aicomfort-prompts-view');
    const sv = shadow.getElementById('aicomfort-settings-view');
    const btn = shadow.getElementById('aicomfort-settings-btn');
    const badge = shadow.getElementById('aicomfort-badge');

    if (settingsOpen) {
      pv.classList.add('ac-view-hidden');
      sv.classList.remove('ac-view-hidden');
      btn.setAttribute('aria-pressed', 'true');
      btn.setAttribute('aria-label', 'Close accessibility settings');
      btn.textContent = '✕';
      badge.textContent = 'Settings';
      announce('Settings panel open');
    } else {
      sv.classList.add('ac-view-hidden');
      pv.classList.remove('ac-view-hidden');
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-label', 'Open accessibility settings');
      btn.textContent = '⚙';
      refreshList(null, true);
      announce('Prompt index visible');
    }
  }

  function applyPanelVisibility(shouldAnnounce = false) {
    panel.classList.toggle('ac-hidden', !panelOpen);
    panel.inert = !panelOpen;
    floatingToggle.style.display = panelOpen ? 'none' : 'flex';

    if (shouldAnnounce) {
      if (panelOpen) {
        shadow.getElementById('aicomfort-collapse-btn')?.focus();
      } else {
        floatingToggle.focus();
      }
      announce(panelOpen ? 'AIComfort panel visible' : 'AIComfort panel hidden');
    }
  }

  function togglePanel() {
    panelOpen = !panelOpen;
    savePanelState();
    applyPanelVisibility(true);
  }

  function getPromptKey(el) {
    if (!el) return null;
    const msgId =
      el.getAttribute('data-message-id') ||
      el.closest('[data-message-id]')?.getAttribute('data-message-id');
    if (msgId) return `id:${msgId}`;
    return `txt:${(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)}`;
  }

  function selectMessage(el, index) {
    selectedMessageEl = el || null;
    selectedMessageKey = getPromptKey(el);
    currentIndex = index;
  }

  function clearSelection() {
    selectedMessageEl = null;
    selectedMessageKey = null;
    currentIndex = -1;
  }

  function resolveSelectedIndex(msgs) {
    if (msgs.length === 0) return -1;

    // Initial load or new conversation: auto-select the last prompt
    if (!selectedMessageEl && !selectedMessageKey) {
      const lastIdx = msgs.length - 1;
      selectMessage(msgs[lastIdx], lastIdx);
      return lastIdx;
    }

    // 1. Exact DOM node match (handles prepended older messages & duplicate texts)
    if (selectedMessageEl) {
      const exactIdx = msgs.indexOf(selectedMessageEl);
      if (exactIdx !== -1) {
        selectedMessageKey = getPromptKey(selectedMessageEl);
        return exactIdx;
      }
    }

    // 2. Fallback by message ID or text (if the framework recreated the DOM node)
    if (selectedMessageKey) {
      const keyIdx = msgs.findIndex((el) => getPromptKey(el) === selectedMessageKey);
      if (keyIdx !== -1) {
        selectedMessageEl = msgs[keyIdx];
        return keyIdx;
      }
    }

    // 3. Selected prompt temporarily outside the rendered DOM: don't highlight another one
    return -1;
  }

  // ─── Prompt index ─────────────────────────────────────────
// ─── Prompt index ─────────────────────────────────────────
  function refreshList(prefetchedMessages = null, shouldScrollList = false) {
    const prevMessages = userMessages;
    userMessages = prefetchedMessages || getUserMessages();
    const isInitialSelection =
      !selectedMessageEl && !selectedMessageKey && userMessages.length > 0;
    currentIndex = resolveSelectedIndex(userMessages);

    const list = shadow.getElementById('aicomfort-list');
    const badge = shadow.getElementById('aicomfort-badge');
    if (!list || settingsOpen) return;

    // Anclar al primer prompt visible antes de reconstruir la lista
    const prevScrollTop = list.scrollTop;
    const listRect = list.getBoundingClientRect();
    let anchorMsg = null;
    let anchorKey = null;
    let anchorOffset = 0;

    if (!shouldScrollList && !isInitialSelection && listRect.height > 0) {
      const prevItems = list.children;
      for (let i = 0; i < prevItems.length && i < prevMessages.length; i++) {
        const rect = prevItems[i].getBoundingClientRect();
        if (rect.bottom > listRect.top) {
          anchorMsg = prevMessages[i];
          anchorKey = getPromptKey(anchorMsg);
          anchorOffset = rect.top - listRect.top;
          break;
        }
      }
    }

    badge.textContent = `${userMessages.length} prompt${userMessages.length !== 1 ? 's' : ''}`;
    list.replaceChildren();

    if (userMessages.length === 0) {
      list.appendChild(createEmptyState());
      return;
    }

    const frag = document.createDocumentFragment();
    userMessages.forEach((msg, i) => {
      const rawText = extractPromptText(msg);
      const doJump = () => {
        selectMessage(msg, i);
        scrollToElement(msg);
        highlightActiveItem();
        announce(`Jumped to prompt ${i + 1}`);
      };

      const item = createEl(
        'div',
        {
          className: i === currentIndex ? 'ac-prompt-item ac-active' : 'ac-prompt-item',
          role: 'listitem',
          tabindex: '0',
          'aria-label': `Prompt ${i + 1}: ${truncate(rawText, 60)}`,
          onClick: doJump,
          onKeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              doJump();
            }
          },
        },
        [
          createEl('span', {
            className: 'ac-prompt-number',
            'aria-hidden': 'true',
            textContent: String(i + 1),
          }),
          createEl('span', {
            className: 'ac-prompt-text',
            textContent: truncate(rawText),
          }),
        ]
      );

      frag.appendChild(item);
    });

    list.appendChild(frag);

    if ((shouldScrollList || isInitialSelection) && currentIndex !== -1) {
      const activeEl = list.children[currentIndex];
      if (activeEl) {
        requestAnimationFrame(() => {
          activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      }
    } else if (anchorMsg) {
      let anchorIdx = userMessages.indexOf(anchorMsg);
      if (anchorIdx === -1 && anchorKey) {
        anchorIdx = userMessages.findIndex((el) => getPromptKey(el) === anchorKey);
      }
      const anchorEl = anchorIdx !== -1 ? list.children[anchorIdx] : null;
      if (anchorEl) {
        const newListRect = list.getBoundingClientRect();
        const newItemRect = anchorEl.getBoundingClientRect();
        list.scrollTop += (newItemRect.top - newListRect.top) - anchorOffset;
      } else {
        list.scrollTop = prevScrollTop;
      }
    } else {
      list.scrollTop = prevScrollTop;
    }
  }

  function highlightActiveItem() {
    const items = shadow.querySelectorAll('.ac-prompt-item');
    items.forEach((el, i) => {
      el.classList.toggle('ac-active', i === currentIndex);
    });
  }

  function jumpToPrompt(direction) {
    const fresh = getUserMessages();
    if (fresh.length === 0) return;

    const nodesChanged =
      fresh.length !== userMessages.length ||
      fresh.some((el, i) => el !== userMessages[i]);
    if (nodesChanged) {
      lastMessageSignature = getMessageSignature(fresh);
      refreshList(fresh);
    }

    let nextIndex;
    if (direction === 'up') {
      nextIndex = currentIndex <= 0 ? userMessages.length - 1 : currentIndex - 1;
    } else {
      nextIndex = currentIndex >= userMessages.length - 1 ? 0 : currentIndex + 1;
    }

    selectMessage(userMessages[nextIndex], nextIndex);
    scrollToElement(userMessages[currentIndex]);
    highlightActiveItem();
    announce(`Prompt ${currentIndex + 1} of ${userMessages.length}`);

    const activeItem = shadow.querySelectorAll('.ac-prompt-item')[currentIndex];
    if (activeItem) activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ─── Keyboard shortcuts ───────────────────────────────────
  function isActivelyEditingText(target) {
    if (!target || !(target instanceof Element)) return false;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      return target.type === 'range' || target.value.trim().length > 0;
    }
    if (target.isContentEditable) {
      return (target.textContent || '').trim().length > 0;
    }
    return false;
  }

  function handleKeyboard(e) {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    if (isActivelyEditingText(e.target)) return;

    e.preventDefault();
    jumpToPrompt(e.key === 'ArrowUp' ? 'up' : 'down');
  }

  // ─── Throttled SPA-aware DOM & theme observers ────────────
  function checkForChanges() {
    const urlChanged = location.href !== lastUrl;
    if (urlChanged) {
      lastUrl = location.href;
      clearSelection();
      cachedScrollContainer = null;
    }

    const fresh = getUserMessages();
    const sig = getMessageSignature(fresh);
    const nodesChanged =
      fresh.length !== userMessages.length ||
      fresh.some((el, i) => el !== userMessages[i]);

    if (urlChanged || nodesChanged || sig !== lastMessageSignature) {
      lastMessageSignature = sig;
      refreshList(fresh);
    }
  }

  /** Leading + trailing throttle: instant updates without streaming starvation */
  function scheduleCheck() {
    const now = Date.now();
    const elapsed = now - lastCheckTime;

    if (elapsed >= CHECK_INTERVAL) {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      lastCheckTime = now;
      checkForChanges();
    } else if (!pendingTimer) {
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        lastCheckTime = Date.now();
        checkForChanges();
      }, CHECK_INTERVAL - elapsed);
    }
  }

  function setupObservers() {
    const domObserver = new MutationObserver(scheduleCheck);
    domObserver.observe(document.body, { childList: true, subtree: true });

    const themeObserver = new MutationObserver(syncTheme);
    const themeOpts = { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] };
    themeObserver.observe(document.documentElement, themeOpts);
    themeObserver.observe(document.body, themeOpts);

    window
      .matchMedia('(prefers-color-scheme: light)')
      .addEventListener('change', syncTheme);
    window.addEventListener('popstate', scheduleCheck);
  }

  // ─── Initialization ──────────────────────────────────────
  loadSettings();
  injectPageBaseStyles();

  const panel = buildPanel();
  const floatingToggle = buildFloatingToggle();
  document.body.appendChild(host);

  syncTheme();
  syncSettingsUI();
  applyPanelVisibility(false);
  applyAccessibilityStyles();

  document.addEventListener('keydown', handleKeyboard);
  setTimeout(checkForChanges, 1000);
  setupObservers();
})();