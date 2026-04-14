/* ============================================================
   AIComfort – Content Script
   Navegación mejorada para Claude · ChatGPT · Gemini
   ============================================================ */

(() => {
  'use strict';

  // ─── Detección de sitio y selector correspondiente ─────────
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

  // ─── Constantes ────────────────────────────────────────────
  const STORAGE_KEY = 'aicomfort-settings';
  const DEFAULTS = {
    highContrast: false,
    fontSize: 0,          // delta: -4 … +8
    openDyslexic: false,
    sepiaMode: false,
    lineHeight: 0,        // delta: 0 = default, up to +1.0
    columnWidth: 0,       // -1 = wider … 0 = default … 5 = narrower
  };

  // ─── Estado ────────────────────────────────────────────────
  let panelOpen = true;
  let settingsOpen = false;
  let currentIndex = -1;
  let userMessages = [];
  let settings = { ...DEFAULTS };

  // ─── Persistencia ──────────────────────────────────────────
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Migración: readingMode → sepiaMode
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

  // ─── Utilidades ────────────────────────────────────────────
  function truncate(text, max = 90) {
    const clean = text.replace(/\s+/g, ' ').trim();
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
   * Encuentra el contenedor scrollable real de la página.
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
    // Fallback: también hacer scroll en window por si el contenedor
    // detectado no es el correcto (p.ej. ChatGPT)
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

  // ─── Inyectar OpenDyslexic desde CDN ──────────────────────
  let dyslexicLoaded = false;
  function ensureDyslexicFont() {
    if (dyslexicLoaded) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.cdnfonts.com/css/opendyslexic';
    document.head.appendChild(link);
    dyslexicLoaded = true;
  }

  // ─── Estilos dinámicos de accesibilidad ────────────────────
  // Todos los estilos se aplican a nivel de html/body para
  // funcionar de forma idéntica en Claude, ChatGPT y Gemini
  // sin depender de selectores específicos de cada DOM.
  let dynamicStyle = null;
  function applyAccessibilityStyles() {
    if (!dynamicStyle) {
      dynamicStyle = document.createElement('style');
      dynamicStyle.id = 'aicomfort-dynamic-styles';
      document.head.appendChild(dynamicStyle);
    }

    // Guardar posición de scroll antes de aplicar cambios para
    // restaurarla después (evita el salto al cambiar font-size).
    let scrollContainer, savedScrollRatio = 0;
    try {
      scrollContainer = getScrollContainer();
      const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      savedScrollRatio = maxScroll > 0 ? scrollContainer.scrollTop / maxScroll : 0;
    } catch (_) { /* ignore */ }

    const rules = [];

    // ── Filtros globales (alto contraste + sepia) ──
    const filters = [];
    if (settings.highContrast) filters.push('contrast(1.35)');
    if (settings.sepiaMode) filters.push('sepia(0.35) saturate(0.85)');
    if (filters.length > 0) {
      rules.push(`html { filter: ${filters.join(' ')} !important; }`);
    }

    // ── Tamaño de fuente ──
    // Porcentaje sobre html evita el efecto compuesto en elementos anidados.
    if (settings.fontSize !== 0) {
      const pct = 100 + settings.fontSize * 0.5;
      rules.push(`html { font-size: ${pct}% !important; }`);
    }

    // ── Fuente OpenDyslexic ──
    // Forzamos la fuente en TODOS los tipos de elemento explícitamente
    // con !important. El patrón inherit no funciona en React/Angular
    // porque sus estilos scoped establecen font-family directamente.
    // Luego restauramos la fuente del panel con un selector de mayor
    // especificidad (#id).
    if (settings.openDyslexic) {
      ensureDyslexicFont();
      rules.push(`
        html, body,
        div, span, p, a, b, em, strong, small, sub, sup,
        h1, h2, h3, h4, h5, h6,
        ul, ol, li, dl, dt, dd,
        table, thead, tbody, tr, th, td,
        form, fieldset, legend, label,
        input, textarea, select, button,
        pre, code, blockquote, cite,
        article, aside, footer, header, main, nav, section {
          font-family: 'OpenDyslexic', 'Open Dyslexic', sans-serif !important;
        }
        #aicomfort-panel,
        #aicomfort-panel * {
          font-family: 'Segoe UI', 'Inter', system-ui, -apple-system, sans-serif !important;
        }
        [class*="icon" i], [class*="Icon"],
        [class*="symbol" i], [class*="material" i],
        mat-icon, mat-icon *,
        .material-icons, .material-icons *,
        .material-symbols-outlined, .material-symbols-outlined *,
        .material-symbols-rounded, .material-symbols-rounded *,
        i[class], i[aria-hidden] {
          font-family: 'Material Symbols Outlined', 'Material Symbols Rounded', 'Material Icons', 'Material Icons Outlined', sans-serif !important;
        }
      `);
    }

    // ── Interlineado ──
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

    // ── Ancho de columna ──
    // Positivo = más estrecho (max-width en hijos directos del body).
    // Negativo = más ancho (elimina restricciones de max-width).
    if (settings.columnWidth > 0) {
      const maxW = Math.max(920 - settings.columnWidth * 40, 720);
      // Contenedor de conversación por sitio
      const containerSel = {
        claude: '#main-content',
        chatgpt: 'main',
        gemini: '.content-container',
      }[site.name] || 'main';
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
          max-width: 320px !important;
          width: 320px !important;
        }
      `);
    }

    dynamicStyle.textContent = rules.join('\n');

    // Restaurar posición de scroll tras el reflow.
    if (scrollContainer) {
      requestAnimationFrame(() => {
        const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
        scrollContainer.scrollTop = savedScrollRatio * maxScroll;
      });
    }
  }

  // ─── Construcción del UI ───────────────────────────────────

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'aicomfort-panel';
    panel.setAttribute('role', 'complementary');
    panel.setAttribute('aria-label', 'AIComfort – Panel de navegación y ajustes de accesibilidad');

    // ── Cabecera ──
    const header = document.createElement('div');
    header.id = 'aicomfort-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'ac-header-left';

    const title = document.createElement('h2');
    title.textContent = 'AIComfort';

    const badge = document.createElement('span');
    badge.id = 'aicomfort-badge';
    badge.textContent = '0 prompts';

    const settingsBtn = document.createElement('button');
    settingsBtn.id = 'aicomfort-settings-btn';
    settingsBtn.setAttribute('aria-label', 'Abrir ajustes de accesibilidad');
    settingsBtn.setAttribute('aria-pressed', 'false');
    settingsBtn.title = 'Ajustes';
    settingsBtn.innerHTML = '⚙';
    settingsBtn.addEventListener('click', toggleSettings);

    titleWrap.appendChild(title);
    titleWrap.appendChild(settingsBtn);
    header.appendChild(titleWrap);
    header.appendChild(badge);
    panel.appendChild(header);

    // ── Vista de prompts ──
    const promptsView = document.createElement('div');
    promptsView.id = 'aicomfort-prompts-view';

    const list = document.createElement('div');
    list.id = 'aicomfort-list';
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Lista de prompts del usuario');
    list.innerHTML = `
      <div class="ac-empty-state">
        <span class="ac-empty-icon">💬</span>
        <span class="ac-empty-text">Aún no hay prompts.<br>Envía un mensaje para comenzar.</span>
      </div>
    `;
    promptsView.appendChild(list);

    const footer = document.createElement('div');
    footer.id = 'aicomfort-footer';
    footer.innerHTML = `
      <div class="ac-shortcut-hint">
        <span class="ac-kbd">Alt</span>+<span class="ac-kbd">↑</span>/<span class="ac-kbd">↓</span>
        Saltar entre prompts
      </div>
    `;
    promptsView.appendChild(footer);
    panel.appendChild(promptsView);

    // ── Vista de ajustes ──
    const settingsView = document.createElement('div');
    settingsView.id = 'aicomfort-settings-view';
    settingsView.className = 'ac-view-hidden';
    settingsView.setAttribute('role', 'region');
    settingsView.setAttribute('aria-label', 'Ajustes de accesibilidad');
    settingsView.innerHTML = buildSettingsHTML();
    panel.appendChild(settingsView);

    // ── Aria‑live region ──
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
            aria-label="Ir al principio de la conversación">⬆ Ir arriba</button>
          <button class="ac-setting-btn ac-scroll-nav-btn" id="ac-btn-scroll-bottom"
            aria-label="Ir al final de la conversación">⬇ Ir abajo</button>
        </div>

        <hr class="ac-divider">

        <!-- Alto contraste -->
        <div class="ac-setting-row">
          <label class="ac-setting-label" id="ac-label-hc">Alto contraste</label>
          <button class="ac-toggle-btn" id="ac-toggle-hc" role="switch"
            aria-checked="false" aria-labelledby="ac-label-hc" tabindex="0">
            <span class="ac-toggle-track"><span class="ac-toggle-thumb"></span></span>
          </button>
        </div>

        <!-- Tamaño de letra -->
        <div class="ac-setting-row">
          <label class="ac-setting-label" id="ac-label-fs">Tamaño de letra</label>
          <div class="ac-stepper">
            <button class="ac-stepper-btn" id="ac-fs-minus"
              aria-label="Reducir tamaño de letra">−</button>
            <span class="ac-stepper-value" id="ac-fs-value"
              aria-live="polite">0</span>
            <button class="ac-stepper-btn" id="ac-fs-plus"
              aria-label="Aumentar tamaño de letra">+</button>
          </div>
        </div>

        <!-- OpenDyslexic -->
        <div class="ac-setting-row">
          <label class="ac-setting-label" id="ac-label-dys">Fuente OpenDyslexic</label>
          <button class="ac-toggle-btn" id="ac-toggle-dys" role="switch"
            aria-checked="false" aria-labelledby="ac-label-dys" tabindex="0">
            <span class="ac-toggle-track"><span class="ac-toggle-thumb"></span></span>
          </button>
        </div>

        <!-- Modo sepia -->
        <div class="ac-setting-row">
          <label class="ac-setting-label" id="ac-label-sp">Modo sepia</label>
          <button class="ac-toggle-btn" id="ac-toggle-sp" role="switch"
            aria-checked="false" aria-labelledby="ac-label-sp" tabindex="0">
            <span class="ac-toggle-track"><span class="ac-toggle-thumb"></span></span>
          </button>
        </div>

        <!-- Interlineado -->
        <div class="ac-setting-row ac-setting-row-col">
          <label class="ac-setting-label" id="ac-label-lh">Interlineado</label>
          <input type="range" id="ac-slider-lh" class="ac-slider"
            min="0" max="100" value="0" step="5"
            aria-label="Interlineado"
            aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        </div>

        <!-- Ancho de columna -->
        <div class="ac-setting-row ac-setting-row-col">
          <div class="ac-slider-label-row">
            <label class="ac-setting-label" id="ac-label-cw">Ancho de columna</label>
            <span class="ac-slider-hint" id="ac-cw-hint">Normal</span>
          </div>
          <input type="range" id="ac-slider-cw" class="ac-slider"
            min="-1" max="5" value="0" step="1"
            aria-label="Ancho de columna"
            aria-valuemin="-1" aria-valuemax="5" aria-valuenow="0">
        </div>

        <!-- Reset -->
        <div class="ac-setting-group">
          <button class="ac-setting-btn ac-reset-btn" id="ac-btn-reset"
            aria-label="Restablecer todos los ajustes a sus valores predeterminados">
            ↺ Restablecer ajustes
          </button>
        </div>

      </div>
    `;
  }

  // ─── Vincular eventos de ajustes ───────────────────────────
  function bindSettingsEvents() {
    // Scroll top/bottom
    document.getElementById('ac-btn-scroll-top')?.addEventListener('click', () => {
      doScrollTop();
      announce('Desplazado al principio');
    });
    document.getElementById('ac-btn-scroll-bottom')?.addEventListener('click', () => {
      doScrollBottom();
      announce('Desplazado al final');
    });

    // Toggle: alto contraste
    bindToggle('ac-toggle-hc', 'highContrast', 'Alto contraste');

    // Font size stepper
    document.getElementById('ac-fs-minus')?.addEventListener('click', () => {
      settings.fontSize = Math.max(settings.fontSize - 1, -4);
      updateFSDisplay();
      applyAndSave();
      announce(`Tamaño de letra: ${settings.fontSize > 0 ? '+' : ''}${settings.fontSize}`);
    });
    document.getElementById('ac-fs-plus')?.addEventListener('click', () => {
      settings.fontSize = Math.min(settings.fontSize + 1, 8);
      updateFSDisplay();
      applyAndSave();
      announce(`Tamaño de letra: ${settings.fontSize > 0 ? '+' : ''}${settings.fontSize}`);
    });

    // Toggle: OpenDyslexic
    bindToggle('ac-toggle-dys', 'openDyslexic', 'Fuente OpenDyslexic');

    // Toggle: Modo sepia
    bindToggle('ac-toggle-sp', 'sepiaMode', 'Modo sepia');

    // Slider: interlineado
    const lhSlider = document.getElementById('ac-slider-lh');
    lhSlider?.addEventListener('input', () => {
      settings.lineHeight = parseFloat(lhSlider.value) / 100; // 0 – 1
      lhSlider.setAttribute('aria-valuenow', lhSlider.value);
      applyAndSave();
    });
    lhSlider?.addEventListener('change', () => {
      announce(`Interlineado: ${Math.round(settings.lineHeight * 100)}%`);
    });

    // Slider: ancho de columna
    const cwSlider = document.getElementById('ac-slider-cw');
    cwSlider?.addEventListener('input', () => {
      settings.columnWidth = parseInt(cwSlider.value, 10);
      cwSlider.setAttribute('aria-valuenow', cwSlider.value);
      updateCWHint();
      applyAndSave();
    });
    cwSlider?.addEventListener('change', () => {
      const hint = document.getElementById('ac-cw-hint');
      announce(`Ancho de columna: ${hint ? hint.textContent : settings.columnWidth}`);
    });

    // Reset
    document.getElementById('ac-btn-reset')?.addEventListener('click', () => {
      settings = { ...DEFAULTS };
      syncSettingsUI();
      applyAndSave();
      announce('Ajustes restablecidos');
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
      announce(`${label}: ${on ? 'activado' : 'desactivado'}`);
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
    if (v < 0) hint.textContent = 'Más ancho';
    else if (v === 0) hint.textContent = 'Normal';
    else hint.textContent = 'Más estrecho';
  }

  /** Sync all settings-UI controls to current `settings` object */
  function syncSettingsUI() {
    // Toggles
    syncToggle('ac-toggle-hc', settings.highContrast);
    syncToggle('ac-toggle-dys', settings.openDyslexic);
    syncToggle('ac-toggle-sp', settings.sepiaMode);

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

  // ─── Toggle de vistas ─────────────────────────────────────
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
      badge.textContent = 'Ajustes';
      announce('Panel de ajustes abierto');
    } else {
      sv.classList.add('ac-view-hidden');
      pv.classList.remove('ac-view-hidden');
      btn.setAttribute('aria-pressed', 'false');
      btn.innerHTML = '⚙';
      refreshList();
      announce('Índice de prompts visible');
    }
  }

  // ─── Toggle del panel ──────────────────────────────────────
  function buildToggle() {
    const btn = document.createElement('button');
    btn.id = 'aicomfort-toggle';
    btn.title = 'Mostrar / Ocultar panel AIComfort';
    btn.setAttribute('aria-label', 'Mostrar u ocultar el panel AIComfort');
    btn.innerHTML = '☰';
    btn.addEventListener('click', togglePanel);
    document.body.appendChild(btn);
    return btn;
  }

  function togglePanel() {
    panelOpen = !panelOpen;
    panel.classList.toggle('ac-hidden', !panelOpen);
    announce(panelOpen ? 'Panel AIComfort visible' : 'Panel AIComfort oculto');
  }

  // ─── Índice de prompts ────────────────────────────────────
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
          <span class="ac-empty-text">Aún no hay prompts.<br>Envía un mensaje para comenzar.</span>
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
        announce(`Saltado al prompt ${i + 1}`);
      };
      item.addEventListener('click', doJump);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doJump(); }
      });

      list.appendChild(item);
    });
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
    announce(`Prompt ${currentIndex + 1} de ${userMessages.length}`);

    const activeItem = document.querySelectorAll('.ac-prompt-item')[currentIndex];
    if (activeItem) activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ─── Atajos de teclado ────────────────────────────────────
  function handleKeyboard(e) {
    if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault();
      jumpToPrompt('up');
    } else if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      jumpToPrompt('down');
    }
  }

  // ─── Observador de cambios en el DOM ──────────────────────
  function setupObserver() {
    const observer = new MutationObserver(() => {
      const fresh = getUserMessages();
      if (fresh.length !== userMessages.length) refreshList();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Inicialización ───────────────────────────────────────
  loadSettings();

  const panel = buildPanel();
  const toggleBtn = buildToggle();
  bindSettingsEvents();
  syncSettingsUI();
  applyAccessibilityStyles();

  document.addEventListener('keydown', handleKeyboard);

  setTimeout(refreshList, 1500);
  setInterval(refreshList, 3000);
  setupObserver();
})();
