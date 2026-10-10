# Exam Lockdown

Secure kiosk app for taking Google Form exams. Opens a Google Form in a locked-down fullscreen window — no other sites, no developer tools, no shortcuts to escape.

## Quick start

```bash
# Install dependencies
npm install

# Run in development (opens in kiosk mode!)
# ⚠️  Have the teacher password ready — you can't close the window without it.
npm start

# Set a custom form and password:
# Windows (PowerShell)
$env:EXAM_URL="https://docs.google.com/forms/d/e/YOUR_FORM_ID/viewform"
$env:EXAM_TEACHER_PASSWORD="MySecret"
npm start

# macOS / Linux
EXAM_URL="https://docs.google.com/forms/d/e/YOUR_FORM_ID/viewform" \
EXAM_TEACHER_PASSWORD="MySecret" \
npm start
```

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `EXAM_URL` | Google Form URL to load | placeholder URL (shows error) |
| `EXAM_TEACHER_PASSWORD` | Teacher exit password (plain text) | `Teacher123!` |
| `EXAM_TEACHER_PASSWORD_SHA256` | SHA-256 hex of the password (takes priority) | unset |

> **Tip:** To get the SHA-256 hash of your password:
> ```bash
> echo -n "MySecret" | shasum -a 256
> ```

## How to exit

Press **Ctrl+Shift+X** (Windows) or **Cmd+Shift+X** (macOS), then enter the teacher password. The default password is `Teacher123!`.

## Building installers

```bash
# Windows: NSIS installer + portable .exe
npm run build:win

# macOS: .dmg with .app
npm run build:mac
```

Build on the target OS. Builds are unsigned in v1, so first launch may show a SmartScreen / Gatekeeper warning.

## What the app blocks

- Opening any site outside Google Forms / Google sign-in
- Developer tools, view source, context menu
- F-keys, Ctrl+R, Ctrl+W, Ctrl+T, Alt+F4, PrintScreen, and many more shortcuts
- Leaving fullscreen, minimizing, resizing, or moving the window
- Closing the app without the teacher password
- Pop-ups, downloads, device permissions (camera, mic, location)

Copy, cut, paste, select-all, undo, and redo still work so students can type their answers.

## What Electron cannot stop

- `Ctrl+Alt+Del`, Windows key, `Win+L`, `Win+D` — these are handled by the OS before apps see them
- Virtual machines, remote desktop, second monitors, a phone
- Someone with admin rights killing the process (Task Manager, `kill`)

**Recommended:** Pair this app with OS-level lockdown on school-managed machines (Windows Assigned Access / kiosk mode, macOS managed profiles) and keep a proctor in the room.

## Project structure

```
exam-lockdown/
├── package.json          # Dependencies and build config
├── main.js               # Main process (all security logic)
├── preload.js            # Preload for the exit prompt (submit/cancel only)
├── exit-prompt.html      # Password prompt UI
├── PRD-SIA.md            # Product requirements
└── README.md             # This file
```

## License

Internal use.
