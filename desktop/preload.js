'use strict';
// Preload: the only bridge between the panel page and the desktop shell.
//
// It exposes exactly the API the Android WebView exposes (ZenBridge with
// notifyReady/requestNotifications), so the shipped panel pages work
// unmodified. ZEN_DESKTOP additionally tells the page it runs on a PC, which
// the update lookup uses to offer desktop releases instead of the APK.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ZenBridge', {
  notifyReady: (title, body, slot, url) =>
    ipcRenderer.invoke('zen:notify-ready', { title, body, slot, url }),
  requestNotifications: () => ipcRenderer.invoke('zen:request-notifications'),
});

contextBridge.exposeInMainWorld('ZEN_DESKTOP', {
  platform: process.platform,
  arch: process.arch,
});
