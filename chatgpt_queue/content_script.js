/* ChatGPT Queue - content_script.js
   Injects a queue UI, handles Alt+Enter to queue prompts while ChatGPT is generating,
   watches DOM for end-of-generation, and auto-sends queued prompts.
*/

(function () {
  'use strict';

  // Simple persistent queue using chrome.storage (fallback to localStorage if missing)
  const storage = {
    async get(key) {
      return new Promise((resolve) => {
        if (chrome && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get(key, (res) => resolve(res[key]));
        } else {
          resolve(JSON.parse(localStorage.getItem(key)));
        }
      });
    },
    async set(obj) {
      return new Promise((resolve) => {
        if (chrome && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set(obj, resolve);
        } else {
          Object.keys(obj).forEach((k) => localStorage.setItem(k, JSON.stringify(obj[k])));
          resolve();
        }
      });
    }
  };

  let queue = [];
  const STORAGE_KEY = 'chatgpt_queue_items_v1';
  const DEBUG_KEY = 'chatgpt_queue_debug_v1';
  let DEBUG = false;

  function log(...args) {
    if (DEBUG) console.log('ChatGPT Queue:', ...args);
  }

  // Utility: find the main input/editor used by ChatGPT
  // Supports <textarea>, <input>, and contenteditable divs (role=textbox)
  function findEditor() {
    // prefer active element if it's an editor
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)) return active;
    // try contenteditable role=textbox first
    const ce = document.querySelector('[role="textbox"][contenteditable="true"], [role="textbox"][contenteditable]');
    if (ce) return ce;
    // fallback: any contenteditable
    const anyCe = document.querySelector('[contenteditable="true"]');
    if (anyCe) return anyCe;
    // fallback textarea/input
    const t = document.querySelector('textarea, input[type="text"]');
    return t || null;
  }

  function isContentEditor(el) {
    return !!(el && (el.isContentEditable || el.getAttribute && el.getAttribute('contenteditable') === 'true'));
  }

  function getEditorText(el) {
    if (!el) return '';
    try {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
      if (isContentEditor(el)) return el.innerText || el.textContent || '';
      return '';
    } catch (e) { return '';
    }
  }

  function setEditorText(el, text) {
    if (!el) return;
    try {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        el.value = text;
      } else if (isContentEditor(el)) {
        // Replace contents preserving basic structure
        el.innerText = text;
      }
      // dispatch input event so React/Framework picks up the change
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      el.focus();
    } catch (e) {
      console.error('ChatGPT Queue: setEditorText error', e);
    }
  }

  function saveQueue() {
    return storage.set({ [STORAGE_KEY]: queue });
  }

  async function loadQueue() {
    const stored = await storage.get(STORAGE_KEY);
    queue = Array.isArray(stored) ? stored : [];
    const dbg = await storage.get(DEBUG_KEY);
    DEBUG = !!dbg;
    log('Loaded queue', queue.length, 'debug=', DEBUG);
  }

  // Heuristic to detect if ChatGPT is currently generating a response.
  // Uses several fallbacks: presence of a Stop button, streaming dots, aria-live status.
  function isGenerating() {
    try {
      log('Checking generating state');

      // Heuristic 1: explicit Stop button (text or aria-label)
      const stopBtn = Array.from(document.querySelectorAll('button')).find(b => {
        const text = (b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '');
        return /stop( generating)?/i.test(text);
      });
      if (stopBtn) {
        log('isGenerating: matched stop button');
        return true;
      }

      // Heuristic 2: role=status elements containing streaming-like text
      const statuses = document.querySelectorAll('[role="status"]');
      for (const s of statuses) {
        const txt = (s.innerText || '').trim();
        if (txt && /generating|thinking|loading|stream|receiving/i.test(txt)) {
          log('isGenerating: matched role=status text:', txt.slice(0, 80));
          return true;
        }
      }

      // Heuristic 3: elements with visible ellipses/dots near messages
      const maybeDots = Array.from(document.querySelectorAll('div,span'))
        .filter(el => {
          try {
            if (!el.offsetParent) return false; // not visible
            const t = (el.innerText || '').trim();
            return /\.\.\.|…|loading|stream/i.test(t);
          } catch (e) { return false; }
        });
      if (maybeDots.length > 0) {
        log('isGenerating: matched visible dots/ellipsis count=', maybeDots.length);
        return true;
      }

      // Heuristic 4: look for elements that look like spinners/animations
      const animated = Array.from(document.querySelectorAll('*')).find(el => {
        try {
          const cls = (el.className || '').toString();
          if (/spinner|loading|animate-spin|animate-pulse|dots|stream/i.test(cls)) return true;
          const style = window.getComputedStyle(el);
          if (style && style.animationName && style.animationName !== 'none') return true;
        } catch (e) { /* ignore */ }
        return false;
      });
      if (animated) {
        log('isGenerating: matched animated element');
        return true;
      }

      // Heuristic 5: specific data attribute used by some clients
      const streaming = document.querySelector('[data-streaming="true"], [data-generating="true"]');
      if (streaming) {
        log('isGenerating: matched data-streaming attribute');
        return true;
      }

      // No heuristics matched
      return false;
    } catch (e) {
      log('isGenerating error', e);
      return false;
    }
  }

  // UI: Build queue panel and attach above input form
  let panel = null;
  let collapsed = true;

  function createPanel() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'cgq-panel';
    panel.className = 'cgq-collapsed';
    panel.innerHTML = `
      <div class="cgq-header">
        <span class="cgq-info">0 prompts queued</span>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="cgq-debug-toggle" title="Toggle debug">🐞</button>
          <button class="cgq-toggle" title="Expand queue">▾</button>
        </div>
      </div>
      <div class="cgq-body" style="display:none"></div>
    `;

    // header actions
    panel.querySelector('.cgq-toggle').addEventListener('click', () => {
      collapsed = !collapsed;
      updateQueueUI();
    });

    const dbgBtn = panel.querySelector('.cgq-debug-toggle');
    if (dbgBtn) {
      dbgBtn.style.opacity = DEBUG ? '1' : '0.5';
      dbgBtn.addEventListener('click', async () => {
        DEBUG = !DEBUG;
        await storage.set({ [DEBUG_KEY]: DEBUG });
        dbgBtn.style.opacity = DEBUG ? '1' : '0.5';
        console.log('ChatGPT Queue: debug', DEBUG);
      });
    }

    return panel;
  }

  function truncateFirstLine(text, max = 80) {
    const first = text.split('\n')[0].trim();
    if (first.length <= max) return first + (text.includes('\n') ? '…' : '');
    return first.slice(0, max - 1) + '…';
  }

  function renderQueueItems() {
    const body = panel.querySelector('.cgq-body');
    body.innerHTML = '';
    queue.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'cgq-item';
      const label = document.createElement('span');
      label.className = 'cgq-item-text';
      label.textContent = `${idx + 1}. "${truncateFirstLine(item)}"`;

      const edit = document.createElement('button');
      edit.className = 'cgq-btn cgq-edit';
      edit.title = 'Edit';
      edit.textContent = '✏️';
      edit.addEventListener('click', () => { loadIntoInput(item); removeAt(idx, false); });

      const del = document.createElement('button');
      del.className = 'cgq-btn cgq-del';
      del.title = 'Delete';
      del.textContent = '🗑️';
      del.addEventListener('click', () => { removeAt(idx, true); });

      row.appendChild(label);
      row.appendChild(edit);
      row.appendChild(del);
      body.appendChild(row);
    });

    const footer = document.createElement('div');
    footer.className = 'cgq-footer';
    if (queue.length > 0) {
      const collapse = document.createElement('button');
      collapse.className = 'cgq-collapse';
      collapse.textContent = '↑ Collapse';
      collapse.addEventListener('click', () => { collapsed = true; updateQueueUI(); });
      footer.appendChild(collapse);
    }
    body.appendChild(footer);
  }

  function updateQueueUI() {
    if (!panel) return;
    const info = panel.querySelector('.cgq-info');
    const toggle = panel.querySelector('.cgq-toggle');
    const body = panel.querySelector('.cgq-body');
    if (queue.length === 0) {
      info.textContent = 'No prompts queued';
      toggle.style.display = 'none';
      body.style.display = 'none';
      panel.classList.add('cgq-empty');
    } else {
      const next = truncateFirstLine(queue[0], 60);
      info.textContent = `${queue.length} prompt${queue.length > 1 ? 's' : ''} queued (next: "${next}")`;
      toggle.style.display = 'inline-block';
      if (collapsed) {
        body.style.display = 'none';
        panel.classList.add('cgq-collapsed');
        panel.classList.remove('cgq-expanded');
        toggle.textContent = '▾';
      } else {
        body.style.display = 'block';
        panel.classList.remove('cgq-collapsed');
        panel.classList.add('cgq-expanded');
        toggle.textContent = '▴';
        renderQueueItems();
      }
    }
  }

  function addToQueue(text) {
    queue.push(text);
    saveQueue();
    updateQueueUI();
    log('Added to queue, length=', queue.length);
  }

  function removeAt(index, save = true) {
    if (index >= 0 && index < queue.length) {
      queue.splice(index, 1);
      if (save) saveQueue();
      updateQueueUI();
      log('Removed index', index, 'new length=', queue.length);
    }
  }

  // When editing, load prompt into input bar. If text exists, append two newlines then prompt.
  function loadIntoInput(text) {
    const editor = findEditor();
    if (!editor) return;
    const existing = getEditorText(editor) || '';
    if (existing && existing.trim().length > 0) {
      setEditorText(editor, existing + '\n\n' + text);
    } else {
      setEditorText(editor, text);
    }
    log('Loaded prompt into input (edit)');
  }

  // Auto-send the next prompt by inserting into textarea and submitting the form
  function sendNextPrompt() {
    if (queue.length === 0) return;
    const next = queue.shift();
    saveQueue();
    updateQueueUI();
    log('Sending next prompt', next);

    const editor = findEditor();
    if (!editor) return;
    setEditorText(editor, next);

    // Try to find the send button inside the same form or nearby
    const form = editor.closest ? editor.closest('form') : null;
    if (form) {
      // try clicking submit button
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) {
        submitBtn.click();
        return;
      }
      // fallback: dispatch submit event
      form.dispatchEvent(new SubmitEvent('submit'));
      return;
    }

    // Try to find a send button in the document (common labels)
    const sendBtn = Array.from(document.querySelectorAll('button'))
      .find(b => /send|submit|reply|enter/i.test((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')));
    if (sendBtn) { sendBtn.click(); return; }

    // final fallback: press Enter key programmatically on the editor
    editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
  }

  // Keyboard handling: Alt+Enter => add to queue only when ChatGPT is generating
  function onKeyDown(e) {
    try {
      if (!(e.key === 'Enter' && e.altKey)) return;
      const editor = e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.isContentEditable)
        ? e.target
        : findEditor();
      if (!editor) return;
      // Always log the Alt+Enter press (helps debugging). Include a short preview of the input.
      try {
        console.log('ChatGPT Queue: Alt+Enter pressed', { host: location.hostname, preview: getEditorText(editor).slice(0, 120) });
      } catch (e) { /* ignore logging failures */ }
      // Only intercept Alt+Enter when ChatGPT is generating
      if (!isGenerating()) {
        log('Ignored Alt+Enter: not generating');
        return;
      }
      e.preventDefault();
      const text = getEditorText(editor).trim();
      if (!text) return;
      addToQueue(text);
      setEditorText(editor, '');
    } catch (err) {
      console.error('ChatGPT Queue: key handler error', err);
    }
  }

  // Monitor generation state using a MutationObserver; when generation stops and queue has items, send next
  let wasGenerating = false;
  function observeGeneration() {
    const observer = new MutationObserver(() => {
      const gen = isGenerating();
      if (wasGenerating && !gen) {
        // generation ended
        if (queue.length > 0) {
          // small debounce to allow UI to settle
          setTimeout(() => {
            sendNextPrompt();
          }, 150);
        }
      }
      wasGenerating = gen;
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: false });
    log('MutationObserver started');
  }

  // Attach panel into the DOM: insert above input form
  function attachPanel() {
    const editor = findEditor();
    if (!editor) return false;
    const form = editor.closest ? editor.closest('form') : null;
    if (!form) return false;

    const container = createPanel();
    // Insert panel directly before form
    if (!form.previousElementSibling || form.previousElementSibling.id !== 'cgq-panel') {
      form.parentNode.insertBefore(container, form);
    }
    updateQueueUI();
    log('Panel attached');
    return true;
  }

  // Initialization
  async function init() {
    await loadQueue();
    createPanel();
    // Try to attach periodically until the input exists
    const tryAttach = setInterval(() => {
      const ok = attachPanel();
      if (ok) clearInterval(tryAttach);
    }, 500);

    // Global keydown listener (delegated)
    document.addEventListener('keydown', onKeyDown, true);

    // Observe generation
    observeGeneration();
    log('Init complete');
  }

  // Run init on DOM ready
  if (document.readyState === 'complete' || document.readyState === 'interactive') init();
  else window.addEventListener('DOMContentLoaded', init);

})();
