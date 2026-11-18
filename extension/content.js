/**
 * Google AI CLI Bridge - Content Script
 *
 * Runs inside google.com/search?udm=50 pages. Handles DOM operations requested
 * by the background service worker (forwarded from the Python CLI).
 */

(function () {
  if (window.__googleai_bridge_injected) {
    return;
  }
  window.__googleai_bridge_injected = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type } = message;

    if (type === 'ping_content') {
      sendResponse({ pong: true });
      return false;
    }

    const handlers = {
      send_prompt: () => handleSendPrompt(message.prompt),
      check_response_status: () => handleCheckResponseStatus(),
      extract_last_code_block: () => handleExtractLastCodeBlock(),
      extract_full_response: () => handleExtractFullResponse(),
      diagnose: () => handleDiagnose(),
    };

    const handler = handlers[type];
    if (!handler) return false;

    handler()
      .then((data) => sendResponse(data || {}))
      .catch((err) => sendResponse({ __error: true, error: err.message || String(err) }));

    return true; // Keep message channel open for async sendResponse
  });

  // ── Prompt Submission ────────────────────────────────────────────────────

  async function handleSendPrompt(prompt) {
    const selectors = [
      'textarea[name="q"]',
      'textarea.gLFyf',
      'textarea',
      'input[name="q"]',
      'input.gLFyf',
      '[role="combobox"]',
      'div[contenteditable="true"]',
    ];

    let inputElement = null;
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) {
        inputElement = el;
        break;
      }
    }

    if (!inputElement) {
      throw new Error(
        'Could not find the Google search/prompt input element. Make sure the page is fully loaded.'
      );
    }

    inputElement.focus();
    const tag = inputElement.tagName.toLowerCase();

    if (tag === 'textarea' || tag === 'input') {
      const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(inputElement, prompt);
      } else {
        inputElement.value = prompt;
      }
      inputElement.dispatchEvent(new Event('input', { bubbles: true }));
      inputElement.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (inputElement.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(inputElement);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, prompt);
    } else {
      inputElement.value = prompt;
      inputElement.dispatchEvent(new Event('input', { bubbles: true }));
      inputElement.dispatchEvent(new Event('change', { bubbles: true }));
    }

    await sleep(400);

    // Ensure hidden or query param udm=50 is maintained if there's a form
    const form = inputElement.closest('form');
    if (form) {
      let udmInput = form.querySelector('input[name="udm"]');
      if (!udmInput) {
        udmInput = document.createElement('input');
        udmInput.type = 'hidden';
        udmInput.name = 'udm';
        udmInput.value = '50';
        form.appendChild(udmInput);
      } else {
        udmInput.value = '50';
      }
    }

    // Submit by pressing Enter
    const enterEventInit = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    };
    inputElement.dispatchEvent(new KeyboardEvent('keydown', enterEventInit));
    inputElement.dispatchEvent(new KeyboardEvent('keypress', enterEventInit));
    inputElement.dispatchEvent(new KeyboardEvent('keyup', enterEventInit));

    // Also click search submit button if Enter alone did not trigger submission
    await sleep(300);
    const submitBtn = document.querySelector(
      'button[type="submit"], button.Tg7LZd, button[aria-label*="Search" i], button[aria-label*="Google Search" i], button[jsname="Tg7LZd"]'
    );
    if (submitBtn && isVisible(submitBtn)) {
      submitBtn.click();
    } else if (form) {
      try {
        form.requestSubmit();
      } catch (e) {
        form.submit();
      }
    }

    return { submitted: true };
  }

  // ── Action Footer Detection ──────────────────────────────────────────────

  /**
   * Find action footers or response toolbars (Copy, Share, Like/Dislike, etc.).
   */
  function findActionFooters() {
    const footers = [];
    const seen = new Set();

    // Selectors for Google AI / AI Overview action toolbars or copy buttons
    const selectors = [
      '[role="toolbar"][aria-label*="actions" i]',
      '[role="toolbar"][aria-label*="result" i]',
      'button[aria-label*="Copy" i]',
      'button[aria-label*="Share" i]',
      '[data-test-id*="copy"]',
      '[data-test-id*="share"]',
    ];

    for (const sel of selectors) {
      const matches = document.querySelectorAll(sel);
      for (const el of matches) {
        if (!isVisible(el)) continue;
        const container =
          el.closest('[role="toolbar"]') ||
          el.closest('[data-attrid]') ||
          el.closest('div') ||
          el.parentElement;
        if (container && !seen.has(container)) {
          seen.add(container);
          footers.push(container);
        }
      }
    }

    return footers;
  }

  function findResponseContainers() {
    const selectors = [
      'div[data-sge-ci]',
      'div[data-attrid="wa:/description"]',
      'div.gizJZe',
      'div.eqAnXb',
      'div[data-ved] div[data-attrid]',
      'div#rso',
      'div#main',
    ];

    const results = [];
    for (const sel of selectors) {
      const els = Array.from(document.querySelectorAll(sel)).filter(isVisible);
      if (els.length > 0) {
        results.push(...els);
      }
    }
    return results;
  }

  // ── Response Status Check ────────────────────────────────────────────────

  async function handleCheckResponseStatus() {
    const footers = findActionFooters();
    const codeBlocks = document.querySelectorAll('pre code, pre, div.code-block code');
    const visibleCodeBlocks = Array.from(codeBlocks).filter(isVisible);

    // Look for loading spinners or progress bars
    const isGenerating = !!document.querySelector(
      '.animate-spin, [role="progressbar"], [aria-label*="Loading" i], [aria-label*="Generating" i], div[jsname*="progress"]'
    );

    const containers = findResponseContainers();
    let contentLength = 0;
    if (containers.length > 0) {
      contentLength = (containers[0].innerText || '').trim().length;
    }

    const diag = {
      actionFooters: footers.length,
      hasCopyBtn: !!document.querySelector('button[aria-label*="Copy" i], [data-test-id*="copy"]'),
      hasShareBtn: !!document.querySelector('button[aria-label*="Share" i], [data-test-id*="share"]'),
      isGenerating,
      textareaFound: !!document.querySelector('textarea, input[name="q"]'),
    };

    return {
      codeBlockCount: visibleCodeBlocks.length,
      contentLength,
      diag,
    };
  }

  // ── Code Block Extraction ────────────────────────────────────────────────

  async function handleExtractLastCodeBlock() {
    const codeBlocks = Array.from(
      document.querySelectorAll('pre code, pre, code.hljs, div.code-block code')
    ).filter(isVisible);

    if (codeBlocks.length === 0) {
      return { text: null, error: 'No code blocks found' };
    }

    const lastBlock = codeBlocks[codeBlocks.length - 1];

    // Strategy 1: Try to find and click a copy button near the code block
    const copiedText = await tryCopyButton(lastBlock);
    if (copiedText) {
      return { text: copiedText, method: 'copy_button' };
    }

    // Strategy 2: Read text content directly
    const text = lastBlock.innerText || lastBlock.textContent;
    if (text && text.trim()) {
      return { text: text.trim(), method: 'innerText' };
    }

    return { text: null, error: 'Code block found but empty' };
  }

  async function tryCopyButton(codeBlockElement) {
    let container = codeBlockElement;
    for (let i = 0; i < 6; i++) {
      container = container.parentElement;
      if (!container || container === document.body) break;

      const btn = container.querySelector(
        'button[aria-label*="Copy" i], button[title*="Copy" i], button.copy-button, button[class*="copy" i]'
      );

      if (btn && isVisible(btn)) {
        try {
          btn.click();
          await sleep(300);
          const text = await navigator.clipboard.readText();
          if (text && text.trim()) {
            return text.trim();
          }
        } catch (e) {
          console.warn('[Google AI CLI Bridge] Clipboard read failed:', e);
        }
      }
    }
    return null;
  }

  // ── Full Response Extraction ─────────────────────────────────────────────

  function findCopyButtonInFooter() {
    const copyBtn = document.querySelector(
      'button[aria-label*="Copy" i], [data-test-id*="copy"], button[title*="Copy" i]'
    );
    if (copyBtn && isVisible(copyBtn)) return copyBtn;

    const footers = findActionFooters();
    if (footers.length === 0) return null;

    const lastFooter = footers[footers.length - 1];
    return lastFooter.querySelector('button, [role="button"]');
  }

  async function handleExtractFullResponse() {
    // ── Strategy 1: Click the Copy button ──────────────────────────
    const copyBtn = findCopyButtonInFooter();
    if (copyBtn) {
      try {
        copyBtn.click();
        await sleep(400);
        const copiedText = await navigator.clipboard.readText();
        if (copiedText && copiedText.trim()) {
          return { text: copiedText.trim(), method: 'copy_button' };
        }
      } catch (e) {
        console.warn('[Google AI CLI Bridge] Footer copy button failed:', e);
      }
    }

    // ── Strategy 2: Fallback to innerText extraction ────────────────
    const selectors = [
      'div[data-sge-ci]',
      'div[data-attrid="wa:/description"]',
      'div.gizJZe',
      'div.eqAnXb',
      'div#rso',
      'div[role="main"]',
    ];

    for (const sel of selectors) {
      const elements = Array.from(document.querySelectorAll(sel)).filter(isVisible);
      if (elements.length > 0) {
        const lastEl = elements[elements.length - 1];
        const text = lastEl.innerText || lastEl.textContent;
        if (text && text.trim()) {
          return { text: text.trim(), method: 'innertext_fallback' };
        }
      }
    }

    return { text: null, error: 'No response containers found' };
  }

  // ── DOM Diagnostics ──────────────────────────────────────────────────────

  async function handleDiagnose() {
    const selectorTests = {
      'textarea': document.querySelector('textarea, input[name="q"]')?.tagName ?? null,
      'actionFooters': findActionFooters().length,
      'button[aria-label*="Copy" i]': !!document.querySelector('button[aria-label*="Copy" i]'),
      'button[aria-label*="Share" i]': !!document.querySelector('button[aria-label*="Share" i]'),
      'pre code': document.querySelectorAll('pre code').length,
      'div[data-sge-ci]': document.querySelectorAll('div[data-sge-ci]').length,
      'div[data-attrid="wa:/description"]': document.querySelectorAll('div[data-attrid="wa:/description"]').length,
    };

    return {
      url: window.location.href,
      actionFooterCount: findActionFooters().length,
      selectorTests,
    };
  }

  // ── Utilities ────────────────────────────────────────────────────────────

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      el.offsetParent !== null
    );
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
