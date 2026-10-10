# PRD: Exam Lockdown

**Secure kiosk app for taking Google Form exams**

| | |
|---|---|
| Version | 0.1 (draft) |
| Date | 2026-10-10 |
| Owner | Wendel |
| Stack | Electron, electron-builder |

---

## 1. Overview

Exam Lockdown is a desktop app (Windows `.exe`, macOS `.app`) that opens a Google Form in a locked-down fullscreen window. Students can only see and use the form: no other sites, no developer tools, no easy shortcuts to switch away. A teacher can close the app with a password.

## 2. Problem

Online exams on student computers are easy to cheat on. Students can open other tabs, search the web, view page source, or switch to other apps. Teachers who already use Google Forms need a simple way to restrict the computer without moving the exam to a heavier platform.

## 3. Goals

1. Show only the exam form, in true kiosk fullscreen.
2. Block navigation to anything outside Google Forms and Google sign-in.
3. Disable the common ways of escaping the window (DevTools, reload, close, minimize, shortcuts).
4. Let only the teacher exit, via a password.
5. Be easy to configure and ship as a normal installable app.

## 4. Non-goals (v1)

- Full proctoring: webcam, screen recording, AI monitoring.
- Defeating OS-level controls (Ctrl+Alt+Del, Win key, Alt+Tab at the OS level). See section 9.
- Detecting virtual machines, remote desktop, second monitors or second devices.
- Supporting exam platforms other than Google Forms.
- Reporting / logging results to a server.

## 5. Users

| User | Needs |
|---|---|
| **Student** | Open the app, sign in if the form requires it, answer the form, submit. Should not need to configure anything. |
| **Teacher / proctor** | Set the form URL and password, distribute the app, close it on a student machine when the exam is over. |

## 6. Assumptions and constraints

- The exam is a Google Form (`docs.google.com/forms/...`), possibly requiring Google sign-in.
- Exam machines are shared or school-managed Windows and macOS computers.
- A teacher or proctor is physically present (the app alone is not enough protection).
- Teachers configure the app by environment variable or by editing defaults before build.
- Electron's built-in dialogs have no text input, so the password prompt is a small custom window rather than an OS-native dialog.

## 7. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| **FR-1** | **Kiosk and fullscreen.** The window opens in `kiosk` + `fullscreen` mode, frameless, always on top. The taskbar, dock, menu bar and title bar are hidden. | P0 |
| **FR-2** | **Window integrity.** The window can't be minimized, resized, moved, or taken out of fullscreen. If it loses focus, it takes focus back (event-based, plus a 1-second watchdog). Closing it (Alt+F4, taskbar, Cmd+Q) does nothing unless the exit password was accepted. | P0 |
| **FR-3** | **Exam URL.** Loads `EXAM_URL`, defaulting to the placeholder `https://docs.google.com/forms/d/e/YOUR_FORM_ID/viewform`. At startup the URL must pass the allow-list, otherwise the app shows an error and quits. | P0 |
| **FR-4** | **Navigation lockdown.** `will-navigate` and `will-redirect` are blocked unless the target is allowed. `setWindowOpenHandler` always denies pop-ups (allowed links open in the same window). Webviews, downloads and device permissions (camera, mic, location, etc.) are denied. | P0 |
| **FR-5** | **URL allow-list.** HTTPS only. Hosts: `docs.google.com` (paths under `/forms/` or `/a/<domain>/forms/` only), `forms.gle`, `accounts.google.com`, `accounts.youtube.com`. Everything else is blocked. | P0 |
| **FR-6** | **No DevTools or context menu.** `devTools: false`, F12 / Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+Shift+C blocked, right-click menu suppressed. | P0 |
| **FR-7** | **Shortcut blocking.** Key events are intercepted (`before-input-event`) and OS-level capture is attempted (`globalShortcut`) for: F1–F24 (incl. F5, F11, F12), Ctrl/Cmd+R, W, T, N, Q, L, P, S, U, O, J, H, M, D, I, Tab, PageUp/Down, Alt+F4, Alt+Tab, Alt+Left/Right, Alt+Home, browser media keys, PrintScreen. Copy, cut, paste, select-all, undo and redo still work so students can type answers. | P0 |
| **FR-8** | **Password-protected exit.** `Ctrl+Shift+X` / `Cmd+Shift+X` opens a password window. The window sends the password to the main process over IPC (`exit:submit`). Correct password: app quits cleanly. Wrong password: app stays locked and shows remaining attempts. Esc / Cancel closes the prompt. | P0 |
| **FR-9** | **Brute-force protection.** 5 wrong attempts lock the prompt for 30 seconds. Only the prompt window may call the IPC channel. Passwords are compared in constant time. | P1 |
| **FR-10** | **Teacher password config.** From `EXAM_TEACHER_PASSWORD`, default `Teacher123!` (with a console warning). Optionally `EXAM_TEACHER_PASSWORD_SHA256` so the plain password isn't stored. | P0 |
| **FR-11** | **Session isolation.** In-memory session (no persisted cookies/logins), spellcheck off, single instance only. | P1 |
| **FR-12** | **Resilience.** If the form fails to load (network drop), retry every 5 seconds. Prevent the display from sleeping during the exam. | P1 |
| **FR-13** | **Packaging.** `npm run build:win` produces an NSIS installer and a portable `.exe`. `npm run build:mac` produces a `.dmg` with the `.app`. | P0 |

## 8. Architecture

**Process model**

- **Main process (`main.js`)** owns everything security-relevant: window creation, navigation guard, key interception, password check, quitting.
- **Exam window**: sandboxed, `contextIsolation: true`, `nodeIntegration: false`, no preload. The remote Google page gets no access to Electron or Node.
- **Prompt window (`exit-prompt.html` + `preload.js`)**: sandboxed, strict CSP. The preload exposes only `submit(password)` and `cancel()` through `contextBridge`.

**Exit flow**

```
Ctrl/Cmd+Shift+X  ->  main: showExitPrompt()
                     prompt window  --ipc 'exit:submit'-->  main: checkPassword()
                       correct  -> allowQuit = true -> app.quit()
                       wrong    -> { remaining } (or lockout after 5)
```

**Project structure**

```
exam-lockdown/
├── package.json
├── main.js
├── preload.js
├── exit-prompt.html
├── PRD.md
└── README.md
```

## 9. Security model

**What the app is designed to stop**

| Attempt | Handled by |
|---|---|
| Opening another site / link / pop-up | FR-4, FR-5 |
| Developer tools, view source | FR-6, FR-7 |
| Reload, new tab, print, save, address bar | FR-7 |
| Leaving fullscreen, minimizing, resizing | FR-2 |
| Closing the app (Alt+F4, Cmd+Q, taskbar) | FR-2 |
| Guessing the teacher password | FR-9 |
| Reusing a previous student's Google login | FR-11 |

**What Electron cannot stop (known limits)**

- `Ctrl+Alt+Del`, the Windows key / Start menu, `Win+L`, `Win+D`: handled by the OS before apps see them. `Alt+Tab` capture is usually rejected by the OS; the focus watchdog pulls the window back, but it isn't airtight.
- Virtual machines, remote desktop, second monitors, a phone or another device.
- Someone with admin rights killing the process (Task Manager, `kill`).
- Environment-variable config on a student-controlled machine: a student who can open a shell could set their own `EXAM_TEACHER_PASSWORD` or `EXAM_URL`.
- A plain-text password or default baked into the app can be extracted from the packaged app.
- macOS: kiosk mode also restricts app switching, but behavior varies by OS version. Test on your target version.

**Recommended mitigations**: pair the app with OS-level lockdown on school-managed machines (Windows Assigned Access / kiosk mode, macOS managed profile), set the password hash at build time instead of using the default, and keep a proctor in the room. If you need stronger guarantees, look at Safe Exam Browser.

## 10. Configuration

| Variable | Purpose | Default |
|---|---|---|
| `EXAM_URL` | Google Form to load | placeholder form URL |
| `EXAM_TEACHER_PASSWORD` | Teacher exit password | `Teacher123!` |
| `EXAM_TEACHER_PASSWORD_SHA256` | Hex SHA-256 of the password (wins over the plain one) | unset |

## 11. Packaging and distribution

- `electron-builder`: Windows NSIS + portable, macOS DMG.
- Build on the target OS. Builds are unsigned in v1, so first launch shows a SmartScreen / Gatekeeper warning.
- Distribute through a school file share or managed-device deployment.

## 12. Acceptance tests (manual)

1. Launch: fullscreen, no taskbar/dock/title bar, form loads.
2. Press F11, F12, F5, Ctrl+R, Ctrl+Shift+I, Ctrl+W, Alt+F4: nothing happens.
3. Right-click: no menu.
4. Click a link to a non-Google site, or paste a URL into a form field and click it: blocked.
5. Try to minimize / resize / un-fullscreen: window snaps back.
6. Click on another app or use Alt+Tab: focus returns within about a second.
7. `Ctrl/Cmd+Shift+X` → wrong password → stays open, shows attempts left.
8. 5 wrong attempts → prompt locked for 30 seconds.
9. Correct password → app quits.
10. Start with an invalid `EXAM_URL` (e.g. `https://example.com`): error and quit.
11. Disconnect Wi-Fi, reconnect: form reloads.
12. Packaged `.exe` and `.app` behave the same as `npm start`.

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| OS-level shortcuts bypass the app | Students switch away | OS lockdown + proctor (section 9) |
| Default password left unchanged | Anyone can exit | Console warning; require password change before deployment |
| Google changes login / form domains | Legit pages get blocked | Keep the allow-list in one place (`ALLOWED_HOSTS`) and test before each exam |
| Teacher gets locked out on a bad config | Exam disrupted | Test exit flow on each machine before the exam; keep the hash/password documented |
| Global shortcut capture affects other apps | Annoying on a personal PC | Only run on exam machines; app unregisters shortcuts on exit |

## 14. Open questions

- Does the form need file upload questions? (Would need Drive domains allowed.)
- Is the form sign-in restricted to a school Google Workspace domain?
- Which OS versions must be supported (Windows 10/11, which macOS)?
- Should the password be baked at build time instead of read from the environment?
- Do you want logging of blocked attempts (v2) so the teacher can review them?

## 15. Milestones

| Milestone | Scope |
|---|---|
| M1 | Kiosk window + URL allow-list + DevTools off |
| M2 | Shortcut blocking + focus watchdog |
| M3 | Password exit flow + lockout |
| M4 | Packaging, testing on target machines |
| v2 (later) | Blocked-attempt log, build-time config, content protection against screenshots |
