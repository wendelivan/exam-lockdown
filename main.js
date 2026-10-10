'use strict';

const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  session,
  powerSaveBlocker,
  dialog,
} = require('electron');
const path = require('path');
const crypto = require('crypto');

/* ═══════════════════════════════════════════════════════════════════════════
   Configuration (FR-3, FR-10)
   ═══════════════════════════════════════════════════════════════════════════ */

const EXAM_URL =
  process.env.EXAM_URL ||
  'https://docs.google.com/forms/d/e/1FAIpQLSdimUkWd8X3OYvyVBEONXhfH1txdVbLxNMW06bf6zq_XrP8HA/viewform';

const TEACHER_PASSWORD = process.env.EXAM_TEACHER_PASSWORD || 'Teacher123!';
const TEACHER_PASSWORD_SHA256 =
  process.env.EXAM_TEACHER_PASSWORD_SHA256 || null;

if (
  !process.env.EXAM_TEACHER_PASSWORD &&
  !process.env.EXAM_TEACHER_PASSWORD_SHA256
) {
  console.warn(
    '[Exam Lockdown] ⚠️  WARNING: Using default teacher password "Teacher123!". ' +
    'Set EXAM_TEACHER_PASSWORD or EXAM_TEACHER_PASSWORD_SHA256 before deployment.'
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   URL Allow-list (FR-5)
   ═══════════════════════════════════════════════════════════════════════════ */

const ALLOWED_HOSTS = [
  'docs.google.com',
  'forms.gle',
  'accounts.google.com',
  'accounts.youtube.com',
];

/**
 * Returns true if the URL is on the allow-list.
 * HTTPS only. docs.google.com is further restricted to /forms/ paths.
 */
function isUrlAllowed(targetUrl) {
  try {
    if (typeof targetUrl === 'string' && targetUrl.startsWith('data:')) return true;
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'https:') return false;
    if (!ALLOWED_HOSTS.includes(parsed.hostname)) return false;
    // docs.google.com: only /forms/ or /a/<domain>/forms/ paths
    if (parsed.hostname === 'docs.google.com') {
      if (!/^\/(forms\/|a\/[^/]+\/forms\/)/.test(parsed.pathname)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Password verification (FR-9, FR-10)
   ═══════════════════════════════════════════════════════════════════════════ */

// Pre-compute the correct hash once at startup.
// If EXAM_TEACHER_PASSWORD_SHA256 is set, use it; otherwise hash the plain password.
const correctHash = TEACHER_PASSWORD_SHA256
  ? TEACHER_PASSWORD_SHA256.toLowerCase()
  : crypto.createHash('sha256').update(TEACHER_PASSWORD).digest('hex');

/**
 * Constant-time password comparison using SHA-256 hashes (FR-9).
 */
function checkPassword(input) {
  const trimmed = String(input || '').trim();
  const inputHash = crypto.createHash('sha256').update(trimmed).digest('hex');
  const a = Buffer.from(inputHash, 'hex');
  const b = Buffer.from(correctHash, 'hex');
  return crypto.timingSafeEqual(a, b);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Brute-force protection (FR-9)
   ═══════════════════════════════════════════════════════════════════════════ */

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000; // 30 seconds
let failedAttempts = 0;
let lockoutUntil = 0;

/* ═══════════════════════════════════════════════════════════════════════════
   Application state & shutdown
   ═══════════════════════════════════════════════════════════════════════════ */

let mainWindow = null;
let promptWindow = null;
let allowQuit = false;
let powerBlockerId = null;
let focusInterval = null;
let examCompleteTimeout = null;

/**
 * Forceful, clean termination of the lockdown application.
 * Clears timers, destroys windows directly to bypass 'closable: false',
 * unregisters shortcuts, and calls app.exit(0).
 */
function terminateApp() {
  allowQuit = true;

  if (examCompleteTimeout) {
    clearTimeout(examCompleteTimeout);
    examCompleteTimeout = null;
  }

  if (focusInterval) {
    clearInterval(focusInterval);
    focusInterval = null;
  }

  if (powerBlockerId !== null) {
    try {
      powerSaveBlocker.stop(powerBlockerId);
      powerBlockerId = null;
    } catch { }
  }

  try {
    globalShortcut.unregisterAll();
  } catch { }

  if (promptWindow && !promptWindow.isDestroyed()) {
    promptWindow.destroy();
    promptWindow = null;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.removeAllListeners('close');
    mainWindow.destroy();
    mainWindow = null;
  }

  app.exit(0);
}

/**
 * Checks whether the given URL indicates the Google Form has been submitted.
 * Upon submitting, Google Forms navigates to .../formResponse.
 */
function isExamSubmissionUrl(targetUrl) {
  try {
    if (!targetUrl) return false;
    const parsed = new URL(targetUrl);
    const isGoogle =
      parsed.hostname === 'docs.google.com' ||
      parsed.hostname.endsWith('.google.com');
    return (
      isGoogle &&
      parsed.pathname.toLowerCase().includes('/formresponse')
    );
  } catch {
    return false;
  }
}

/**
 * Handles automatic exit when a student finishes the exam.
 * Injects a visual notification banner and closes the app in 4 seconds.
 */
function handleExamSubmitted() {
  if (examCompleteTimeout) return;
  console.log('[Exam Lockdown] Exam submission detected. Closing app automatically in 4s...');

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(`
      (() => {
        if (document.getElementById('lockdown-completed-banner')) return;
        const banner = document.createElement('div');
        banner.id = 'lockdown-completed-banner';
        banner.style.cssText = [
          'position: fixed',
          'top: 32px',
          'left: 50%',
          'transform: translateX(-50%)',
          'background: #090d16',
          'color: #f8fafc',
          'padding: 18px 30px',
          'border-radius: 14px',
          'box-shadow: 0 20px 40px rgba(0,0,0,0.6)',
          'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          'z-index: 2147483647',
          'display: flex',
          'align-items: center',
          'gap: 16px',
          'border: 1px solid rgba(255,255,255,0.2)'
        ].join(';');
        banner.innerHTML = '<div style="font-size:26px;">🎉</div><div><div style="font-weight:700;font-size:16px;color:#fff;">Exam Submitted!</div><div style="font-size:13px;color:#94a3b8;margin-top:2px;">Your response has been recorded. Exiting in <span id="countdown-val" style="font-weight:600;color:#38bdf8;">4</span>s...</div></div>';
        document.body.appendChild(banner);
        let sec = 4;
        const timer = setInterval(() => {
          sec--;
          const el = document.getElementById('countdown-val');
          if (el) el.textContent = sec;
          if (sec <= 0) clearInterval(timer);
        }, 1000);
      })();
    `).catch(() => { });
  }

  examCompleteTimeout = setTimeout(() => {
    terminateApp();
  }, 4000);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Single instance lock (FR-11)
   ═══════════════════════════════════════════════════════════════════════════ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.restore();
    mainWindow.focus();
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Keyboard shortcut definitions (FR-7)
   ═══════════════════════════════════════════════════════════════════════════ */

// Keys that are ALLOWED with Ctrl/Cmd (copy, cut, paste, select-all, undo, redo)
const PASS_THROUGH_KEYS = new Set(['c', 'x', 'v', 'a', 'z', 'y']);

// Ctrl/Cmd + <key> combos to block
const BLOCKED_CTRL_KEYS = new Set([
  'r', 'w', 't', 'n', 'q', 'l', 'p', 's', 'u', 'o', 'j', 'h', 'm', 'd', 'i',
  'tab', 'pageup', 'pagedown',
]);

// Ctrl/Cmd + Shift + <key> combos to block
const BLOCKED_CTRL_SHIFT_KEYS = new Set(['i', 'j', 'c', 'tab']);

// Alt + <key> combos to block
const BLOCKED_ALT_KEYS = new Set([
  'f4', 'tab', 'arrowleft', 'arrowright', 'home',
]);

// Global shortcut accelerators to register at OS level
const GLOBAL_ACCELERATORS = [
  // F-keys
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  // Ctrl/Cmd combos
  'CommandOrControl+R',
  'CommandOrControl+W',
  'CommandOrControl+T',
  'CommandOrControl+N',
  'CommandOrControl+Q',
  'CommandOrControl+L',
  'CommandOrControl+P',
  'CommandOrControl+S',
  'CommandOrControl+U',
  'CommandOrControl+O',
  'CommandOrControl+J',
  'CommandOrControl+H',
  'CommandOrControl+M',
  'CommandOrControl+D',
  'CommandOrControl+I',
  'CommandOrControl+Tab',
  'CommandOrControl+Shift+I',
  'CommandOrControl+Shift+J',
  'CommandOrControl+Shift+C',
  'CommandOrControl+Shift+Tab',
  // Alt combos
  'Alt+Left',
  'Alt+Right',
  'Alt+Home',
  'Alt+F4',
  'Alt+Tab',
  // Special keys
  'PrintScreen',
];

/* ═══════════════════════════════════════════════════════════════════════════
   before-input-event handler (FR-6, FR-7)
   ═══════════════════════════════════════════════════════════════════════════ */

function handleBeforeInput(event, input) {
  if (input.type !== 'keyDown') return;

  const key = input.key.toLowerCase();
  const ctrl = input.control || input.meta; // Ctrl on Windows, Cmd on macOS
  const shift = input.shift;
  const alt = input.alt;

  // Block all F-keys (F1–F24)
  if (/^f([1-9]|1\d|2[0-4])$/.test(key)) {
    event.preventDefault();
    return;
  }

  // Block PrintScreen
  if (key === 'printscreen') {
    event.preventDefault();
    return;
  }

  // Ctrl/Cmd + Shift combos
  if (ctrl && shift) {
    // Allow Ctrl+Shift+X (exit prompt) — handled separately below
    if (key === 'x') return;
    // Allow Ctrl+Shift+Z (redo on some platforms)
    if (key === 'z') return;
    if (BLOCKED_CTRL_SHIFT_KEYS.has(key)) {
      event.preventDefault();
      return;
    }
  }

  // Ctrl/Cmd combos (no shift, no alt)
  if (ctrl && !shift && !alt) {
    if (PASS_THROUGH_KEYS.has(key)) return; // allow copy/cut/paste/select-all/undo/redo
    if (BLOCKED_CTRL_KEYS.has(key)) {
      event.preventDefault();
      return;
    }
  }

  // Alt combos
  if (alt) {
    if (BLOCKED_ALT_KEYS.has(key)) {
      event.preventDefault();
      return;
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Create the exam window (FR-1, FR-2, FR-4, FR-6, FR-11, FR-12)
   ═══════════════════════════════════════════════════════════════════════════ */

function createMainWindow() {
  // In-memory session — no 'persist:' prefix means nothing is saved to disk (FR-11)
  const examSession = session.fromPartition('exam-session');

  // Block all device permissions: camera, mic, location, etc. (FR-4)
  examSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  examSession.setPermissionCheckHandler(() => false);

  // Block downloads (FR-4)
  examSession.on('will-download', (dlEvent) => {
    dlEvent.preventDefault();
  });

  mainWindow = new BrowserWindow({
    // FR-1: Kiosk + fullscreen, frameless, always-on-top
    kiosk: true,
    fullscreen: true,
    fullscreenable: true,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#0c0c18',
    // FR-2: Prevent user from closing/minimizing/resizing
    closable: false,
    minimizable: false,
    maximizable: false,
    resizable: false,
    movable: false,
    skipTaskbar: false,
    webPreferences: {
      devTools: false, // FR-6
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // No preload for the exam window — the Google page gets no Electron/Node access
      spellcheck: false, // FR-11
      session: examSession,
      webviewTag: false, // FR-4: block <webview>
    },
  });

  // Hide the menu bar entirely
  mainWindow.setMenuBarVisibility(false);
  mainWindow.removeMenu();

  // ── Navigation lockdown (FR-4) ──────────────────────────────────────────

  mainWindow.webContents.on('will-navigate', (navEvent, navUrl) => {
    if (!isUrlAllowed(navUrl)) {
      navEvent.preventDefault();
    }
  });

  mainWindow.webContents.on('will-redirect', (redirEvent, redirUrl) => {
    if (!isUrlAllowed(redirUrl)) {
      redirEvent.preventDefault();
    }
  });

  // Block pop-ups; open allowed links in the same window instead (FR-4)
  mainWindow.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    if (isUrlAllowed(popupUrl)) {
      mainWindow.loadURL(popupUrl);
    }
    return { action: 'deny' };
  });

  // ── Context menu suppression (FR-6) ─────────────────────────────────────

  mainWindow.webContents.on('context-menu', (ctxEvent) => {
    ctxEvent.preventDefault();
  });

  // ── Shortcut blocking via before-input-event (FR-7) + exit trigger (FR-8) ─

  mainWindow.webContents.on('before-input-event', (biEvent, biInput) => {
    handleBeforeInput(biEvent, biInput);

    // Detect Ctrl/Cmd+Shift+X for the exit prompt (FR-8)
    if (
      biInput.type === 'keyDown' &&
      (biInput.control || biInput.meta) &&
      biInput.shift &&
      biInput.key.toLowerCase() === 'x'
    ) {
      showExitPrompt();
    }
  });

  // ── Window integrity (FR-2) ─────────────────────────────────────────────

  // Block close unless the teacher password was accepted
  mainWindow.on('close', (closeEvent) => {
    if (!allowQuit) {
      closeEvent.preventDefault();
    }
  });

  // Snap back if minimized
  mainWindow.on('minimize', () => {
    mainWindow.restore();
  });

  // Snap back if leaving fullscreen
  mainWindow.on('leave-full-screen', () => {
    mainWindow.setFullScreen(true);
    mainWindow.setKiosk(true);
  });

  // Event-based focus recovery: pull focus back when blurred
  mainWindow.on('blur', () => {
    setTimeout(() => {
      if (promptWindow && !promptWindow.isDestroyed()) {
        promptWindow.focus();
        promptWindow.setAlwaysOnTop(true, 'screen-saver');
        return;
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus();
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
      }
    }, 50);
  });

  // Watchdog: ensure fullscreen/kiosk and focus (FR-2)
  focusInterval = setInterval(() => {
    if (promptWindow && !promptWindow.isDestroyed()) {
      if (!promptWindow.isFocused()) {
        promptWindow.focus();
        promptWindow.setAlwaysOnTop(true, 'screen-saver');
      }
      return;
    }

    if (!mainWindow || mainWindow.isDestroyed()) return;

    if (!mainWindow.isFocused()) {
      mainWindow.focus();
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
    }
    if (!mainWindow.isFullScreen()) mainWindow.setFullScreen(true);
    if (!mainWindow.isKiosk()) mainWindow.setKiosk(true);
  }, 500);

  // ── Resilience: retry on load failure (FR-12) ───────────────────────────

  mainWindow.webContents.on(
    'did-fail-load',
    (_failEvent, errorCode, errorDesc) => {
      // Ignore aborted navigations
      if (errorCode === -3) return;

      console.log(
        `[Exam Lockdown] Page load failed (${errorCode}: ${errorDesc}). Retrying in 5 s…`
      );

      const retryHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body {
              margin:0; background:#0c0c18; color:#d4d4e0; font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; text-align:center;
            }
            .spinner {
              width: 44px; height: 44px; border: 4px solid rgba(255,255,255,0.1); border-top-color: #6366f1; border-radius: 50%;
              animation: spin 1s linear infinite; margin-bottom: 24px;
            }
            @keyframes spin { to { transform: rotate(360deg); } }
            h2 { font-size: 20px; font-weight: 600; margin: 0 0 8px; color: #fff; }
            p { font-size: 14px; color: #8888a4; margin: 0; }
          </style>
        </head>
        <body>
          <div class="spinner"></div>
          <h2>Connecting to Exam...</h2>
          <p>Please check your internet connection. Retrying automatically in 5 seconds...</p>
        </body>
        </html>
      `;
      mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(retryHtml));

      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(EXAM_URL);
        }
      }, 5000);
    }
  );

  // ── Automatic exit upon exam submission (Google Form completed) ─────────

  mainWindow.webContents.on('did-navigate', (_navEvent, navUrl) => {
    if (isExamSubmissionUrl(navUrl)) {
      handleExamSubmitted();
    }
  });

  mainWindow.webContents.on('did-navigate-in-page', (_navEvent, navUrl) => {
    if (isExamSubmissionUrl(navUrl)) {
      handleExamSubmitted();
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const currentUrl = mainWindow.webContents.getURL();
    if (isExamSubmissionUrl(currentUrl)) {
      handleExamSubmitted();
      return;
    }

    // Fallback: check DOM text for submission confirmation in case of URL redirect quirks
    mainWindow.webContents
      .executeJavaScript(`
        (() => {
          const text = document.body ? document.body.innerText.toLowerCase() : '';
          return (
            text.includes('your response has been recorded') ||
            text.includes('has been recorded') ||
            text.includes('naitala na ang iyong tugon') ||
            document.querySelector('.freebirdFormviewerViewResponseConfirmationMessage') !== null
          );
        })()
      `)
      .then((isSubmitted) => {
        if (isSubmitted) {
          handleExamSubmitted();
        }
      })
      .catch(() => { });
  });

  // ── Load the exam ───────────────────────────────────────────────────────

  mainWindow.loadURL(EXAM_URL);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
}

/* ═══════════════════════════════════════════════════════════════════════════
   Exit prompt window (FR-8)
   ═══════════════════════════════════════════════════════════════════════════ */

function showExitPrompt() {
  // If already open, just focus it
  if (promptWindow && !promptWindow.isDestroyed()) {
    promptWindow.focus();
    promptWindow.setAlwaysOnTop(true, 'screen-saver');
    return;
  }

  // Not parented or modal to avoid Windows disabling the kiosk window
  promptWindow = new BrowserWindow({
    width: 420,
    height: 340,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
      devTools: false,
    },
  });

  promptWindow.setAlwaysOnTop(true, 'screen-saver');
  promptWindow.removeMenu();
  promptWindow.loadFile('exit-prompt.html');

  // Intercept before-input-event on the prompt window too (blocks Alt+Tab while prompt is open)
  promptWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    const ctrl = input.control || input.meta;
    const alt = input.alt;

    // Block Alt, Tab, F-keys, PrintScreen, and browser shortcuts
    if (
      alt ||
      /^f([1-9]|1\d|2[0-4])$/.test(key) ||
      key === 'tab' ||
      key === 'printscreen' ||
      (ctrl && key !== 'v' && key !== 'a')
    ) {
      event.preventDefault();
    }
  });

  // Rapid blur recovery on prompt window
  promptWindow.on('blur', () => {
    setTimeout(() => {
      if (promptWindow && !promptWindow.isDestroyed()) {
        promptWindow.focus();
        promptWindow.setAlwaysOnTop(true, 'screen-saver');
      }
    }, 50);
  });

  // Show once ready to avoid flash of empty window
  promptWindow.once('ready-to-show', () => {
    promptWindow.show();
    promptWindow.focus();
    promptWindow.setAlwaysOnTop(true, 'screen-saver');
  });

  // Send the current lockout/attempt state once the page loads
  promptWindow.webContents.on('did-finish-load', () => {
    if (!promptWindow || promptWindow.isDestroyed()) return;
    const now = Date.now();
    if (now < lockoutUntil) {
      promptWindow.webContents.send('exit:state', {
        locked: true,
        lockoutRemaining: Math.ceil((lockoutUntil - now) / 1000),
      });
    } else {
      promptWindow.webContents.send('exit:state', {
        locked: false,
        remaining: MAX_ATTEMPTS - failedAttempts,
      });
    }
  });

  promptWindow.on('closed', () => {
    promptWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   IPC handlers (FR-8, FR-9)
   ═══════════════════════════════════════════════════════════════════════════ */

ipcMain.handle('exit:submit', (event, password) => {
  // Security: only accept calls from the prompt window's webContents
  if (
    !promptWindow ||
    promptWindow.isDestroyed() ||
    event.sender !== promptWindow.webContents
  ) {
    return { error: 'Unauthorized' };
  }

  const now = Date.now();

  // Enforce lockout
  if (now < lockoutUntil) {
    return {
      success: false,
      locked: true,
      lockoutRemaining: Math.ceil((lockoutUntil - now) / 1000),
    };
  }

  // Correct password → terminate app cleanly and immediately
  if (checkPassword(password)) {
    allowQuit = true;
    setTimeout(() => {
      terminateApp();
    }, 150);
    return { success: true };
  }

  // Wrong password
  failedAttempts++;
  const remaining = MAX_ATTEMPTS - failedAttempts;

  if (remaining <= 0) {
    // Trigger lockout
    lockoutUntil = now + LOCKOUT_MS;
    failedAttempts = 0; // reset counter for the next lockout cycle
    return {
      success: false,
      locked: true,
      lockoutRemaining: Math.ceil(LOCKOUT_MS / 1000),
    };
  }

  return { success: false, remaining };
});

ipcMain.on('exit:cancel', (event) => {
  if (
    promptWindow &&
    !promptWindow.isDestroyed() &&
    event.sender === promptWindow.webContents
  ) {
    promptWindow.close();
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Global shortcut registration (FR-7)
   ═══════════════════════════════════════════════════════════════════════════ */

function registerGlobalShortcuts() {
  for (const accel of GLOBAL_ACCELERATORS) {
    try {
      globalShortcut.register(accel, () => {
        /* swallow */
      });
    } catch {
      // Some accelerators may not be registerable on every platform
    }
  }

  // Register the exit-prompt shortcut separately
  try {
    globalShortcut.register('CommandOrControl+Shift+X', () => {
      showExitPrompt();
    });
  } catch {
    // Fallback: handled by before-input-event
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   App lifecycle
   ═══════════════════════════════════════════════════════════════════════════ */

app.on('ready', () => {
  // FR-3: Validate EXAM_URL at startup
  if (!isUrlAllowed(EXAM_URL)) {
    dialog.showErrorBox(
      'Invalid Exam URL',
      `The configured EXAM_URL is not allowed:\n\n${EXAM_URL}\n\n` +
      'The URL must be an HTTPS Google Forms URL.\n' +
      'Set the EXAM_URL environment variable to a valid Google Forms URL.'
    );
    allowQuit = true;
    app.quit();
    return;
  }

  // FR-12: Prevent the display from sleeping during the exam
  powerBlockerId = powerSaveBlocker.start('prevent-display-sleep');

  // FR-7: Register global shortcuts
  registerGlobalShortcuts();

  // Create the locked-down exam window
  createMainWindow();
});

// FR-2: Block quitting unless the teacher password was accepted
app.on('before-quit', (bqEvent) => {
  if (!allowQuit) {
    bqEvent.preventDefault();
  }
});

// Clean up on quit
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (focusInterval) clearInterval(focusInterval);
  if (powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
  }
});

// Keep the app running even if all windows are somehow closed
app.on('window-all-closed', () => {
  // Do nothing — prevent the default quit behavior
});

// macOS: re-focus the main window when the dock icon is clicked
app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
  }
});

// Block <webview> creation in any renderer (FR-4)
app.on('web-contents-created', (_wcEvent, contents) => {
  contents.on('will-attach-webview', (attachEvent) => {
    attachEvent.preventDefault();
  });
});
