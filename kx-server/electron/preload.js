// electron/preload.js — the only bridge between the launcher page and Node.
//
// The launcher window runs with contextIsolation on and nodeIntegration off,
// so launcher.html has no access to the file system, the network stack or
// child processes. It can do exactly five things, listed here. Adding a
// capability means adding a line to this file, which is the point: the surface
// stays small enough to read.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kx', {
  /** Addresses, saved settings, data folder and version, for first paint. */
  init: () => ipcRenderer.invoke('kx:init'),

  /** Full path a database name resolves to — shown under the field. */
  resolveDb: name => ipcRenderer.invoke('kx:resolve-db', name),

  /** Native file picker; resolves to a path, or null if cancelled. */
  browseDb: name => ipcRenderer.invoke('kx:browse-db', name),

  /** Start the server if needed, then open the user interface in the browser. */
  launch: form => ipcRenderer.invoke('kx:launch', form),

  /** Stop the server and close the application. */
  quit: () => ipcRenderer.invoke('kx:quit'),

  /** Server came up or went away — the launcher redraws its status line. */
  onStatus: handler => ipcRenderer.on('kx:status', (_e, status) => handler(status)),
});
