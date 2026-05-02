/* ============================================================
   AIComfort – Content Script
   Enhanced navigation for Claude · ChatGPT · Gemini
   ============================================================ */

(() => {
  'use strict';

  // ─── Site detection and selectors ──────────────────────────
  const SITE_CONFIG = {
    claude: {
      host: 'claude.ai',
      selector: "div[data-testid='user-message']",
      scrollContainerSelectors: [
        '[class*="ThreadLayout"]',
        '[class*="thread"]',
        'main [class*="scroll"]',
        'main',
      ],
    },
    chatgpt: {
      host: 'chatgpt.com',
      selector: 'div.user-message-bubble-color',
      scrollContainerSelectors: [
        '[class*="react-scroll-to-bottom"] > div',
        'main [role="presentation"]',
        'main div[class*="overflow-y"]',
        'main',
      ],
    },
    gemini: {
      host: 'gemini.google.com',
      selector: "div.query-text[role='heading']",
      scrollContainerSelectors: [
        '.conversation-container',
        'main [class*="scroll"]',
        'main',
      ],
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
  const DEFAULTS = {
    highContrast: false,
    fontSize: 0,          // delta: -4 … +8
    sepiaMode: false,
    lineHeight: 0,        // delta: 0 = default, up to +1.0
    columnWidth: 0,       // -1 = wider … 0 = default … 5 = narrower
    alignLeft: false,     // shift conversation to the left
  };

  // ─── State ─────────────────────────────────────────────────
  let panelOpen = true;
  let settingsOpen = false;
  let currentIndex = -1;
  let userMessages = [];
  let settings = { ...DEFAULTS };

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
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (_) { /* ignore */ }
  }

  // ─── Utilities ─────────────────────────────────────────────
  function truncate(text, max = 90) {
    let clean = text.replace(/\s+/g, ' ').trim();
    // Gemini prepends "Has dicho" / "You said" to user prompts
    clean = clean.replace(/^(Has dicho|You said)\s*/i, '');
    return clean.length > max ? clean.slice(0, max) + '…' : clean;
  }

  /** Announce a change to screen readers via aria-live region */
  function announce(msg) {
    const el = document.getElementById('aicomfort-live');
    if (el) {
      el.textContent = '';
      requestAnimationFrame(() => { el.textContent = msg; });
    }
  }

  /**
   * Finds the real scrollable container of the page.
   */
  function getScrollContainer() {
    for (const sel of site.scrollContainerSelectors) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight) return el;
    }
    const msgs = getUserMessages();
    if (msgs.length > 0) {
      let node = msgs[0].parentElement;
      while (node && node !== document.body && node !== document.documentElement) {
        const style = getComputedStyle(node);
        const ov = style.overflowY;
        if ((ov === 'auto' || ov === 'scroll') && node.scrollHeight > node.clientHeight + 20) {
          return node;
        }
        node = node.parentElement;
      }
    }
    let best = null;
    let bestArea = 0;
    document.querySelectorAll('main, [role="main"], div').forEach((el) => {
      const style = getComputedStyle(el);
      const overflows = style.overflowY === 'auto' || style.overflowY === 'scroll';
      if (overflows && el.scrollHeight > el.clientHeight + 50) {
        const area = el.clientWidth * el.clientHeight;
        if (area > bestArea) { bestArea = area; best = el; }
      }
    });
    return best || document.documentElement;
  }

  function doScrollTop() {
    const c = getScrollContainer();
    c.scrollTo({ top: 0, behavior: 'smooth' });
    // Fallback: also scroll window in case the detected container
    // is not the correct one (e.g. ChatGPT)
    if (c !== document.documentElement && c !== document.body) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function doScrollBottom() {
    const c = getScrollContainer();
    c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
    if (c !== document.documentElement && c !== document.body) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    }
  }

  function scrollToElement(el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('ac-highlight');
    setTimeout(() => el.classList.remove('ac-highlight'), 900);
  }

  function getUserMessages() {
    return Array.from(document.querySelectorAll(site.selector));
  }

  // ─── Conversation container selector per site ──────────────
  function getContainerSel() {
    return {
      claude: '#main-content',
      chatgpt: 'main',
      gemini: '.content-container',
    }[site.name] || 'main';
  }

  // ─── Dynamic accessibility styles ─────────────────────────
  // All styles are applied at html/body level so they work
  // identically on Claude, ChatGPT and Gemini.
  let dynamicStyle = null;
  function applyAccessibilityStyles() {
    if (!dynamicStyle) {
      dynamicStyle = document.createElement('style');
      dynamicStyle.id = 'aicomfort-dynamic-styles';
      document.head.appendChild(dynamicStyle);
    }

    // Save scroll position before applying changes to prevent
    // the scroll-to-top jump when changing font-size.
    let scrollContainer, savedScrollRatio = 0;
    try {
      scrollContainer = getScrollContainer();
      const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      savedScrollRatio = maxScroll > 0 ? scrollContainer.scrollTop / maxScroll : 0;
    } catch (_) { /* ignore */ }

    const rules = [];

    // ── Global filters (high contrast + sepia) ──
    const filters = [];
    if (settings.highContrast) filters.push('contrast(1.35)');
    if (settings.sepiaMode) filters.push('sepia(0.35) saturate(0.85)');
    if (filters.length > 0) {
      rules.push(`html { filter: ${filters.join(' ')} !important; }`);
    }

    // ── Font size ──
    // Percentage on html avoids compounding on nested elements.
    if (settings.fontSize !== 0) {
      const pct = 100 + settings.fontSize * 0.5;
      rules.push(`html { font-size: ${pct}% !important; }`);
    }

    // ── Line height ──
    if (settings.lineHeight > 0) {
      const lh = 1.8 + settings.lineHeight;
      rules.push(`
        body * {
          line-height: ${lh} !important;
        }
        #aicomfort-panel,
        #aicomfort-panel * {
          line-height: 1.45 !important;
        }
      `);
    }

    // ── Column width ──
    // Positive = narrower (max-width on conversation container).
    // Negative = wider (removes max-width constraints).
    const containerSel = getContainerSel();
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
        body * {
          max-width: 100% !important;
        }
        #aicomfort-panel {
          max-width: 280px !important;
          width: 280px !important;
        }
      `);
    }

    // ── Align conversation to the left ──
    // Chat sites center messages using either:
    //   a) flex containers with align-items:center
    //   b) wrapper divs with max-width + margin:0 auto
    // We use align-items:flex-start on the container hierarchy to
    // shift content left, and only override margin on the first
    // few levels of wrapper divs — NOT on all descendants, which
    // would break internal button/input layouts.
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

    // Restore scroll position after reflow.
    if (scrollContainer) {
      requestAnimationFrame(() => {
        const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
        scrollContainer.scrollTop = savedScrollRatio * maxScroll;
      });
    }
  }

  // ─── UI construction ──────────────────────────────────────

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'aicomfort-panel';
    panel.setAttribute('role', 'complementary');
    panel.setAttribute('aria-label', 'AIComfort – Navigation and accessibility settings panel');

    // ── Header ──
    // Layout: [⚙ settings] [badge] ─── [AIComfort]
    // The ☰ toggle button lives outside the panel (see below).
    const header = document.createElement('div');
    header.id = 'aicomfort-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'ac-header-left';

    const settingsBtn = document.createElement('button');
    settingsBtn.id = 'aicomfort-settings-btn';
    settingsBtn.setAttribute('aria-label', 'Open accessibility settings');
    settingsBtn.setAttribute('aria-pressed', 'false');
    settingsBtn.title = 'Settings';
    settingsBtn.innerHTML = '⚙';
    settingsBtn.addEventListener('click', toggleSettings);

    const badge = document.createElement('span');
    badge.id = 'aicomfort-badge';
    badge.textContent = '0 prompts';

    const title = document.createElement('h2');
    title.textContent = 'AIComfort';

    headerLeft.appendChild(settingsBtn);
    headerLeft.appendChild(badge);
    header.appendChild(headerLeft);
    header.appendChild(title);
    panel.appendChild(header);

    // ── Prompts view ──
    const promptsView = document.createElement('div');
    promptsView.id = 'aicomfort-prompts-view';

    const list = document.createElement('div');
    list.id = 'aicomfort-list';
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'User prompt list');
    list.innerHTML = `
      <div class="ac-empty-state">
        <span class="ac-empty-icon">💬</span>
        <span class="ac-empty-text">No prompts yet.<br>Send a message to get started.</span>
      </div>
    `;
    promptsView.appendChild(list);

    const footer = document.createElement('div');
    footer.id = 'aicomfort-footer';
    footer.innerHTML = `
      <div class="ac-shortcut-hint">
        <span class="ac-kbd">Alt</span>+<span class="ac-kbd">↑</span>/<span class="ac-kbd">↓</span>
        Jump between prompts
      </div>
    `;
    // Toggle button integrated in the footer
    const footerToggle = document.createElement('button');
    footerToggle.className = 'ac-footer-toggle';
    footerToggle.title = 'Hide panel';
    footerToggle.setAttribute('aria-label', 'Hide the AIComfort panel');
    footerToggle.innerHTML = '☰';
    footerToggle.addEventListener('click', togglePanel);
    footer.appendChild(footerToggle);
    promptsView.appendChild(footer);
    panel.appendChild(promptsView);

    // ── Settings view ──
    const settingsView = document.createElement('div');
    settingsView.id = 'aicomfort-settings-view';
    settingsView.className = 'ac-view-hidden';
    settingsView.setAttribute('role', 'region');
    settingsView.setAttribute('aria-label', 'Accessibility settings');
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = buildSettingsHTML();
    settingsView.replaceChildren(...tempDiv.childNodes);
    panel.appendChild(settingsView);

    // ── Aria-live region ──
    const live = document.createElement('div');
    live.id = 'aicomfort-live';
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    live.className = 'ac-sr-only';
    document.body.appendChild(live);

    document.body.appendChild(panel);
    return panel;
  }

  function buildSettingsHTML() {
    return `
      <div class="ac-settings-scroll">

        <!-- Scroll top/bottom -->
        <div class="ac-setting-group ac-scroll-group">
          <button class="ac-setting-btn ac-scroll-nav-btn" id="ac-btn-scroll-top"
            aria-label="Scroll to top of conversation">⬆ Go to top</button>
          <button class="ac-setting-btn ac-scroll-nav-btn" id="ac-btn-scroll-bottom"
            aria-label="Scroll to bottom of conversation">⬇ Go to bottom</button>
        </div>

        <hr class="ac-divider">

        <!-- High contrast -->
        <div class="ac-setting-row">
          <label class="ac-setting-label" id="ac-label-hc">High contrast</label>
          <button class="ac-toggle-btn" id="ac-toggle-hc" role="switch"
            aria-checked="false" aria-labelledby="ac-label-hc" tabindex="0">
            <span class="ac-toggle-track"><span class="ac-toggle-thumb"></span></span>
          </button>
        </div>

        <!-- Font size -->
        <div class="ac-setting-row">
          <label class="ac-setting-label" id="ac-label-fs">Font size</label>
          <div class="ac-stepper">
            <button class="ac-stepper-btn" id="ac-fs-minus"
              aria-label="Decrease font size">−</button>
            <span class="ac-stepper-value" id="ac-fs-value"
              aria-live="polite">0</span>
            <button class="ac-stepper-btn" id="ac-fs-plus"
              aria-label="Increase font size">+</button>
          </div>
        </div>

        <!-- Sepia mode -->
        <div class="ac-setting-row">
          <label class="ac-setting-label" id="ac-label-sp">Sepia mode</label>
          <button class="ac-toggle-btn" id="ac-toggle-sp" role="switch"
            aria-checked="false" aria-labelledby="ac-label-sp" tabindex="0">
            <span class="ac-toggle-track"><span class="ac-toggle-thumb"></span></span>
          </button>
        </div>

        <!-- Line height -->
        <div class="ac-setting-row ac-setting-row-col">
          <label class="ac-setting-label" id="ac-label-lh">Line height</label>
          <input type="range" id="ac-slider-lh" class="ac-slider"
            min="0" max="100" value="0" step="5"
            aria-label="Line height"
            aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        </div>

        <!-- Column width -->
        <div class="ac-setting-row ac-setting-row-col">
          <div class="ac-slider-label-row">
            <label class="ac-setting-label" id="ac-label-cw">Column width</label>
            <span class="ac-slider-hint" id="ac-cw-hint">Normal</span>
          </div>
          <input type="range" id="ac-slider-cw" class="ac-slider"
            min="-1" max="5" value="0" step="1"
            aria-label="Column width"
            aria-valuemin="-1" aria-valuemax="5" aria-valuenow="0">
        </div>

        <!-- Align left -->
        <div class="ac-setting-row">
          <label class="ac-setting-label" id="ac-label-al">Align left</label>
          <button class="ac-toggle-btn" id="ac-toggle-al" role="switch"
            aria-checked="false" aria-labelledby="ac-label-al" tabindex="0">
            <span class="ac-toggle-track"><span class="ac-toggle-thumb"></span></span>
          </button>
        </div>

        <!-- Reset -->
        <div class="ac-setting-group">
          <button class="ac-setting-btn ac-reset-btn" id="ac-btn-reset"
            aria-label="Reset all settings to default values">
            ↺ Reset settings
          </button>
        </div>

      </div>
    `;
  }

  // ─── Settings event bindings ───────────────────────────────
  function bindSettingsEvents() {
    // Scroll top/bottom
    document.getElementById('ac-btn-scroll-top')?.addEventListener('click', () => {
      doScrollTop();
      announce('Scrolled to top');
    });
    document.getElementById('ac-btn-scroll-bottom')?.addEventListener('click', () => {
      doScrollBottom();
      announce('Scrolled to bottom');
    });

    // Toggle: high contrast
    bindToggle('ac-toggle-hc', 'highContrast', 'High contrast');

    // Font size stepper
    document.getElementById('ac-fs-minus')?.addEventListener('click', () => {
      settings.fontSize = Math.max(settings.fontSize - 1, -4);
      updateFSDisplay();
      applyAndSave();
      announce(`Font size: ${settings.fontSize > 0 ? '+' : ''}${settings.fontSize}`);
    });
    document.getElementById('ac-fs-plus')?.addEventListener('click', () => {
      settings.fontSize = Math.min(settings.fontSize + 1, 8);
      updateFSDisplay();
      applyAndSave();
      announce(`Font size: ${settings.fontSize > 0 ? '+' : ''}${settings.fontSize}`);
    });

    // Toggle: sepia mode
    bindToggle('ac-toggle-sp', 'sepiaMode', 'Sepia mode');

    // Slider: line height
    const lhSlider = document.getElementById('ac-slider-lh');
    lhSlider?.addEventListener('input', () => {
      settings.lineHeight = parseFloat(lhSlider.value) / 100; // 0 – 1
      lhSlider.setAttribute('aria-valuenow', lhSlider.value);
      applyAndSave();
    });
    lhSlider?.addEventListener('change', () => {
      announce(`Line height: ${Math.round(settings.lineHeight * 100)}%`);
    });

    // Slider: column width
    const cwSlider = document.getElementById('ac-slider-cw');
    cwSlider?.addEventListener('input', () => {
      settings.columnWidth = parseInt(cwSlider.value, 10);
      cwSlider.setAttribute('aria-valuenow', cwSlider.value);
      updateCWHint();
      applyAndSave();
    });
    cwSlider?.addEventListener('change', () => {
      const hint = document.getElementById('ac-cw-hint');
      announce(`Column width: ${hint ? hint.textContent : settings.columnWidth}`);
    });

    // Toggle: align left
    bindToggle('ac-toggle-al', 'alignLeft', 'Align left');

    // Reset
    document.getElementById('ac-btn-reset')?.addEventListener('click', () => {
      settings = { ...DEFAULTS };
      syncSettingsUI();
      applyAndSave();
      announce('Settings reset');
    });
  }

  function bindToggle(btnId, settingKey, label) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      settings[settingKey] = !settings[settingKey];
      const on = settings[settingKey];
      btn.setAttribute('aria-checked', String(on));
      btn.classList.toggle('ac-on', on);
      applyAndSave();
      announce(`${label}: ${on ? 'on' : 'off'}`);
    });
  }

  function applyAndSave() {
    applyAccessibilityStyles();
    saveSettings();
  }

  function updateFSDisplay() {
    const el = document.getElementById('ac-fs-value');
    if (el) {
      const v = settings.fontSize;
      el.textContent = (v > 0 ? '+' : '') + v;
    }
  }

  function updateCWHint() {
    const hint = document.getElementById('ac-cw-hint');
    if (!hint) return;
    const v = settings.columnWidth;
    if (v < 0) hint.textContent = 'Wider';
    else if (v === 0) hint.textContent = 'Normal';
    else hint.textContent = 'Narrower';
  }

  /** Sync all settings-UI controls to current `settings` object */
  function syncSettingsUI() {
    // Toggles
    syncToggle('ac-toggle-hc', settings.highContrast);
    syncToggle('ac-toggle-sp', settings.sepiaMode);
    syncToggle('ac-toggle-al', settings.alignLeft);

    // Font size
    updateFSDisplay();

    // Sliders
    const lh = document.getElementById('ac-slider-lh');
    if (lh) {
      lh.value = Math.round(settings.lineHeight * 100);
      lh.setAttribute('aria-valuenow', lh.value);
    }
    const cw = document.getElementById('ac-slider-cw');
    if (cw) {
      cw.value = settings.columnWidth;
      cw.setAttribute('aria-valuenow', cw.value);
    }
    updateCWHint();
  }

  function syncToggle(id, on) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.setAttribute('aria-checked', String(on));
    btn.classList.toggle('ac-on', on);
  }

  // ─── View toggle ──────────────────────────────────────────
  function toggleSettings() {
    settingsOpen = !settingsOpen;
    const pv = document.getElementById('aicomfort-prompts-view');
    const sv = document.getElementById('aicomfort-settings-view');
    const btn = document.getElementById('aicomfort-settings-btn');
    const badge = document.getElementById('aicomfort-badge');

    if (settingsOpen) {
      pv.classList.add('ac-view-hidden');
      sv.classList.remove('ac-view-hidden');
      btn.setAttribute('aria-pressed', 'true');
      btn.innerHTML = '✕';
      badge.textContent = 'Settings';
      announce('Settings panel open');
    } else {
      sv.classList.add('ac-view-hidden');
      pv.classList.remove('ac-view-hidden');
      btn.setAttribute('aria-pressed', 'false');
      btn.innerHTML = '⚙';
      refreshList();
      announce('Prompt index visible');
    }
  }

  // ─── Floating toggle (visible only when panel is hidden) ───
  let floatingToggle = null;
  function buildFloatingToggle() {
    const btn = document.createElement('button');
    btn.id = 'aicomfort-toggle';
    btn.title = 'Show AIComfort panel';
    btn.setAttribute('aria-label', 'Show the AIComfort panel');
    btn.innerHTML = '☰';
    btn.style.display = 'none'; // hidden by default (panel starts open)
    btn.addEventListener('click', togglePanel);
    document.body.appendChild(btn);
    return btn;
  }

  function togglePanel() {
    panelOpen = !panelOpen;
    panel.classList.toggle('ac-hidden', !panelOpen);
    if (floatingToggle) floatingToggle.style.display = panelOpen ? 'none' : 'flex';
    announce(panelOpen ? 'AIComfort panel visible' : 'AIComfort panel hidden');
  }

  // ─── Prompt index ─────────────────────────────────────────
  function refreshList() {
    userMessages = getUserMessages();
    const list = document.getElementById('aicomfort-list');
    const badge = document.getElementById('aicomfort-badge');
    if (!list || settingsOpen) return;

    badge.textContent = `${userMessages.length} prompt${userMessages.length !== 1 ? 's' : ''}`;

    if (userMessages.length === 0) {
      list.innerHTML = `
        <div class="ac-empty-state">
          <span class="ac-empty-icon">💬</span>
          <span class="ac-empty-text">No prompts yet.<br>Send a message to get started.</span>
        </div>
      `;
      return;
    }

    list.innerHTML = '';
    userMessages.forEach((msg, i) => {
      const item = document.createElement('div');
      item.className = 'ac-prompt-item';
      item.setAttribute('role', 'listitem');
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-label', `Prompt ${i + 1}: ${truncate(msg.textContent, 60)}`);
      if (i === currentIndex) item.classList.add('ac-active');

      const num = document.createElement('span');
      num.className = 'ac-prompt-number';
      num.textContent = i + 1;
      num.setAttribute('aria-hidden', 'true');

      const text = document.createElement('span');
      text.className = 'ac-prompt-text';
      text.textContent = truncate(msg.textContent);

      item.appendChild(num);
      item.appendChild(text);

      const doJump = () => {
        currentIndex = i;
        scrollToElement(msg);
        highlightActiveItem();
        announce(`Jumped to prompt ${i + 1}`);
      };
      item.addEventListener('click', doJump);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doJump(); }
      });

      list.appendChild(item);
    });

    // Auto-select the last prompt if none is selected yet
    if (userMessages.length > 0 && currentIndex === -1) {
      currentIndex = userMessages.length - 1;
    }
    // Ensure the active item is visually highlighted and scrolled into view
    highlightActiveItem();
    const activeEl = list.children[currentIndex];
    if (activeEl) {
      requestAnimationFrame(() => {
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    }
  }

  function highlightActiveItem() {
    const items = document.querySelectorAll('.ac-prompt-item');
    items.forEach((el, i) => {
      el.classList.toggle('ac-active', i === currentIndex);
    });
  }

  function jumpToPrompt(direction) {
    userMessages = getUserMessages();
    if (userMessages.length === 0) return;

    if (direction === 'up') {
      currentIndex = currentIndex <= 0 ? userMessages.length - 1 : currentIndex - 1;
    } else {
      currentIndex = currentIndex >= userMessages.length - 1 ? 0 : currentIndex + 1;
    }

    scrollToElement(userMessages[currentIndex]);
    highlightActiveItem();
    announce(`Prompt ${currentIndex + 1} of ${userMessages.length}`);

    const activeItem = document.querySelectorAll('.ac-prompt-item')[currentIndex];
    if (activeItem) activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ─── Keyboard shortcuts ───────────────────────────────────
  function handleKeyboard(e) {
    if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault();
      jumpToPrompt('up');
    } else if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      jumpToPrompt('down');
    }
  }

  // ─── DOM change observer ──────────────────────────────────
  function setupObserver() {
    const observer = new MutationObserver(() => {
      const fresh = getUserMessages();
      if (fresh.length !== userMessages.length) refreshList();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Initialization ──────────────────────────────────────
  loadSettings();

  const panel = buildPanel();
  floatingToggle = buildFloatingToggle();
  bindSettingsEvents();
  syncSettingsUI();
  applyAccessibilityStyles();

  document.addEventListener('keydown', handleKeyboard);

  setTimeout(refreshList, 1500);
  //setInterval(refreshList, 3000);
  setupObserver();
})();
