/**
 * Google AI CLI Bridge - Background Service Worker
 *
 * Manages the WebSocket connection to the Python CLI server
 * and routes commands between the CLI and the content script.
 */

const WS_URL = 'ws://127.0.0.1:18768';
const GOOGLE_AI_URL = 'https://www.google.com/search?udm=50';
let ws = null;
let isConnected = false;

// ── Service Worker Keepalive ─────────────────────────────────────────────

chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    ensureConnection();
  }
});

// ── WebSocket Connection ─────────────────────────────────────────────────

function broadcastStatus() {
  chrome.runtime.sendMessage({
    type: 'status_update',
    connected: isConnected,
  }).catch(() => {});
}

function ensureConnection() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }
  connectWebSocket();
}

function connectWebSocket() {
  if (ws) {
    try { ws.close(); } catch (e) { /* ignore */ }
    ws = null;
  }

  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    // Server not running — silently retry on next alarm
    return;
  }

  ws.onopen = () => {
    console.log('[Google AI CLI Bridge] Connected to CLI server');
    isConnected = true;
    broadcastStatus();
  };

  ws.onclose = () => {
    console.log('[Google AI CLI Bridge] Disconnected from CLI server');
    isConnected = false;
    ws = null;
    broadcastStatus();
  };

  ws.onerror = () => {
    // onclose will fire after this
    isConnected = false;
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleCommand(msg);
    } catch (e) {
      console.error('[Google AI CLI Bridge] Failed to parse message:', e);
    }
  };
}

// ── Command Handling ─────────────────────────────────────────────────────

function sendWsResponse(id, success, data = {}, error = null) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const response = { id, success };
  if (success) {
    response.data = data;
  } else {
    response.error = error || 'Unknown error';
  }
  ws.send(JSON.stringify(response));
}

async function handleCommand(msg) {
  const { id, type, ...params } = msg;
  if (!id || !type) return;

  try {
    switch (type) {
      case 'ping':
        sendWsResponse(id, true, { pong: true });
        break;

      case 'find_googleai_tab': {
        const tabs = await queryGoogleAITabs();
        const tabsData = tabs.map((t) => ({
          id: t.id,
          url: t.url,
          title: t.title,
        }));
        sendWsResponse(id, true, { tabs: tabsData });
        break;
      }

      case 'activate_tab': {
        if (!params.tabId) throw new Error('tabId is required');
        const tab = await chrome.tabs.update(params.tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        sendWsResponse(id, true, { activated: true });
        break;
      }

      case 'open_googleai_tab': {
        const newTab = await chrome.tabs.create({ url: GOOGLE_AI_URL, active: true });
        // Wait for the page to finish loading
        await new Promise((resolve) => {
          const listener = (tabId, info) => {
            if (tabId === newTab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          // Timeout after 30 seconds
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }, 30000);
        });
        // Extra delay for content script to inject
        await new Promise((r) => setTimeout(r, 2000));
        sendWsResponse(id, true, { tabId: newTab.id });
        break;
      }

      // DOM operations — forward to content script
      case 'send_prompt':
      case 'check_response_status':
      case 'extract_last_code_block':
      case 'extract_full_response':
      case 'diagnose': {
        const targetTab = await findGoogleAITab();
        if (!targetTab) {
          throw new Error('No Google AI (udm=50) tab found. Open google.com/search?udm=50 first.');
        }

        // Ensure content script is injected
        await ensureContentScript(targetTab.id);

        // Forward the full message to the content script
        const response = await sendToContentScript(targetTab.id, msg);

        // Check if the content script reported an error
        if (response && response.__error) {
          sendWsResponse(id, false, null, response.error);
        } else {
          sendWsResponse(id, true, response);
        }
        break;
      }

      default:
        sendWsResponse(id, false, null, `Unknown command type: ${type}`);
    }
  } catch (error) {
    console.error(`[Google AI CLI Bridge] Error handling "${type}":`, error);
    sendWsResponse(id, false, null, error.message);
  }
}

// ── Helper Functions ─────────────────────────────────────────────────────

async function queryGoogleAITabs(filter = {}) {
  const tabs = await chrome.tabs.query(filter);
  // Match any tab on google.com containing udm=50 or google.com search/home
  return tabs.filter((t) => {
    if (!t.url) return false;
    const url = t.url.toLowerCase();
    return url.includes('google.com') && (url.includes('udm=50') || url.includes('/search') || url.includes('google.com'));
  });
}

async function findGoogleAITab() {
  // 1. Prefer active tab that explicitly has udm=50 in the current window
  let activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  let udmTab = activeTabs.find((t) => t.url && t.url.includes('udm=50'));
  if (udmTab) return udmTab;

  // 2. Any active Google tab in current window
  let googleActive = activeTabs.find((t) => t.url && t.url.includes('google.com'));
  if (googleActive) return googleActive;

  // 3. Any tab anywhere with udm=50
  let allTabs = await chrome.tabs.query({});
  let anyUdm = allTabs.find((t) => t.url && t.url.includes('udm=50'));
  if (anyUdm) return anyUdm;

  // 4. Any Google tab
  let anyGoogle = allTabs.find((t) => t.url && t.url.includes('google.com'));
  return anyGoogle || null;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (e) {
    console.debug('[Google AI CLI Bridge] Content script injection:', e.message);
  }
}

function sendToContentScript(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ── Popup Communication ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'get_status') {
    sendResponse({ connected: isConnected });
  } else if (message.type === 'reconnect') {
    connectWebSocket();
    sendResponse({ reconnecting: true });
  }
  return false;
});

// ── Initial Connection ───────────────────────────────────────────────────

connectWebSocket();
