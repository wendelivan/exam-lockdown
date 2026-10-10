'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload for the exit-prompt window (FR-8).
 *
 * Exposes exactly two actions (submit / cancel) and one listener (onState)
 * through contextBridge. The renderer has no other access to Electron or Node.
 */
contextBridge.exposeInMainWorld('exitPrompt', {
  /** Send the teacher password to the main process for verification. */
  submit: (password) => ipcRenderer.invoke('exit:submit', password),

  /** Close the prompt without submitting. */
  cancel: () => ipcRenderer.send('exit:cancel'),

  /**
   * Receive the initial state (locked / remaining attempts) from main.
   * Called once when the prompt page finishes loading.
   */
  onState: (callback) => {
    ipcRenderer.on('exit:state', (_event, data) => callback(data));
  },
});
