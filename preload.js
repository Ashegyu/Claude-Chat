const { contextBridge, ipcRenderer } = require('electron');
const hljs = require('highlight.js/lib/common');

contextBridge.exposeInMainWorld('electronAPI', {
  cli: {
    run: (opts) => ipcRenderer.invoke('cli:run', opts),
    stop: (id) => ipcRenderer.invoke('cli:stop', { id }),
    write: (id, data) => ipcRenderer.invoke('cli:write', { id, data }),
    onStream: (cb) => {
      const handler = (_, data) => cb(data);
      ipcRenderer.on('cli:stream', handler);
      return () => ipcRenderer.removeListener('cli:stream', handler);
    },
    onDone: (cb) => {
      const handler = (_, data) => cb(data);
      ipcRenderer.on('cli:done', handler);
      return () => ipcRenderer.removeListener('cli:done', handler);
    },
    onError: (cb) => {
      const handler = (_, data) => cb(data);
      ipcRenderer.on('cli:error', handler);
      return () => ipcRenderer.removeListener('cli:error', handler);
    },
    onTurnDone: (cb) => {
      const handler = (_, data) => cb(data);
      ipcRenderer.on('cli:turnDone', handler);
      return () => ipcRenderer.removeListener('cli:turnDone', handler);
    },
  },
  cwd: {
    get: () => ipcRenderer.invoke('cwd:get'),
    set: (dir) => ipcRenderer.invoke('cwd:set', dir),
    select: () => ipcRenderer.invoke('cwd:select'),
  },
  file: {
    pickAndRead: () => ipcRenderer.invoke('file:pickAndRead'),
    read: (filePath) => ipcRenderer.invoke('file:read', { filePath }),
    readMultiple: (filePaths) => ipcRenderer.invoke('file:readMultiple', { filePaths }),
    open: (filePath) => ipcRenderer.invoke('file:open', { filePath }),
  },
  repo: {
    getFileDiffs: (arg) => ipcRenderer.invoke('repo:getFileDiffs', arg),
    getStatus: (arg) => ipcRenderer.invoke('repo:getStatus', arg),
    commit: (arg) => ipcRenderer.invoke('repo:commit', arg),
    generateCommitMessage: (arg) => ipcRenderer.invoke('repo:generateCommitMessage', arg),
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximized: (cb) => {
      const handler = (_, v) => cb(v);
      ipcRenderer.on('window:maximized', handler);
      return () => ipcRenderer.removeListener('window:maximized', handler);
    },
  },
  help: {
    openManual: () => ipcRenderer.invoke('help:openManual'),
  },
  claude: {
    rateLimits: () => ipcRenderer.invoke('codex:rateLimits'),
    listSessions: (limit) => ipcRenderer.invoke('codex:listSessions', limit),
    loadSession: (arg) => ipcRenderer.invoke('codex:loadSession', arg),
    deleteSession: (arg) => ipcRenderer.invoke('codex:deleteSession', arg),
    getSessionDiffs: (arg) => ipcRenderer.invoke('codex:getSessionDiffs', arg),
    listAgents: (arg) => ipcRenderer.invoke('codex:listAgents', arg),
  },
  store: {
    loadConversations: () => ipcRenderer.invoke('store:loadConversations'),
    saveConversations: (data) => ipcRenderer.invoke('store:saveConversations', data),
    saveConversationsSync: (data) => ipcRenderer.sendSync('store:saveConversationsSync', data),
  },
  system: {
    info: () => ipcRenderer.invoke('system:info'),
  },
});

contextBridge.exposeInMainWorld('hljs', {
  highlight: (code, opts) => {
    try {
      const result = hljs.highlight(code, opts);
      return { value: result.value };
    } catch { return { value: code }; }
  },
  highlightAuto: (code) => {
    try {
      const result = hljs.highlightAuto(code);
      return { value: result.value };
    } catch { return { value: code }; }
  },
  getLanguage: (lang) => {
    try { return hljs.getLanguage(lang) ? true : false; }
    catch { return false; }
  },
});
