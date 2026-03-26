const { app, BrowserWindow, ipcMain, screen, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

let mainWindow = null;
let manualWindow = null;
const runningProcesses = new Map();
let resolvedCliPaths = {}; // command name → resolved absolute path 캐시
const MAX_FILE_IMPORT_BYTES = 180 * 1024;
const MAX_IMAGE_IMPORT_BYTES = 20 * 1024 * 1024; // 이미지는 20MB까지
const MAX_PDF_IMPORT_BYTES = 10 * 1024 * 1024; // PDF는 10MB까지

// 파일 확장자별 분류
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.tif']);
const PDF_EXTENSIONS = new Set(['.pdf']);
const BINARY_DOC_EXTENSIONS = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp']);
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.gz', '.7z', '.rar', '.bz2']);

// 마지막으로 수신한 rate limit 정보 캐시
let lastRateLimitInfo = null;
// 세션 누적 사용량 (비용, 토큰)
let sessionUsage = { totalCostUsd: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, turnCount: 0 };
// PTY 기반 /usage 캐시
let cachedUsageData = null;
let usageFetchInProgress = false;

// 최소한의 ANSI 제거 (edge case용)
function stripAnsi(text) {
  return text
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1B\].*?(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[\?[0-9;]*[hl]/g, '')
    .replace(/\x1B\([A-Z0-9]/g, '')
    .replace(/\x1B[=>MNOP78]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/\uFFFD/g, '');
}

function resolveFilePath(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw) return '';
  const cleaned = raw.replace(/^['"]|['"]$/g, '');
  return path.normalize(path.isAbsolute(cleaned) ? cleaned : path.join(workingDirectory, cleaned));
}

function resolveOpenFileTarget(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw) return { resolvedPath: '', line: null };

  let value = raw.replace(/^['"]|['"]$/g, '');
  let line = null;

  const lineMatch = /#L(\d+)$/i.exec(value);
  if (lineMatch) {
    const parsedLine = Number(lineMatch[1]);
    line = Number.isFinite(parsedLine) && parsedLine > 0 ? parsedLine : null;
    value = value.slice(0, lineMatch.index);
  }

  if (/^file:\/\//i.test(value)) {
    try {
      const fileUrl = new URL(value);
      value = decodeURIComponent(fileUrl.pathname || '');
    } catch {
      // invalid file url - fallback to raw path parsing
    }
  } else {
    try {
      value = decodeURIComponent(value);
    } catch {
      // ignore malformed percent encoding
    }
  }

  // renderer에서 /C:/... 형식으로 전달하는 Windows 절대경로 보정
  if (/^\/[A-Za-z]:\//.test(value)) {
    value = value.slice(1);
  }

  // URL 형태로 전달된 경로를 OS 경로 형태로 복원
  if (value.includes('/')) {
    value = value.replace(/\//g, path.sep);
  }

  return {
    resolvedPath: resolveFilePath(value),
    line,
  };
}

function runGitCommandAsync(args, cwd) {
  return new Promise((resolve) => {
    try {
      const child = spawn('git', args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      child.stdout?.on('data', (data) => {
        stdout += typeof data === 'string' ? data : data.toString('utf8');
      });
      child.stderr?.on('data', (data) => {
        stderr += typeof data === 'string' ? data : data.toString('utf8');
      });
      child.on('error', (error) => {
        finish({
          ok: false,
          status: 1,
          stdout,
          stderr,
          error: String(error?.message || error),
        });
      });
      child.on('close', (status) => {
        finish({
          ok: Number(status) === 0,
          status: Number.isFinite(Number(status)) ? Number(status) : 1,
          stdout,
          stderr,
          error: '',
        });
      });
    } catch (error) {
      resolve({
        ok: false,
        status: 1,
        stdout: '',
        stderr: '',
        error: String(error?.message || error),
      });
    }
  });
}

function normalizeRepoFilePath(inputPath, repoRoot, fallbackCwd) {
  const raw = String(inputPath || '').trim();
  if (!raw) return '';

  const { resolvedPath } = resolveOpenFileTarget(raw);
  let absolutePath = resolvedPath;
  if (!absolutePath) {
    const candidate = raw.replace(/^['"]|['"]$/g, '').replace(/^\/([A-Za-z]:[\\/])/, '$1');
    absolutePath = path.isAbsolute(candidate) ? candidate : path.join(fallbackCwd, candidate);
  }
  if (!absolutePath) return '';

  const normalizedAbs = path.normalize(absolutePath);
  const normalizedRoot = path.normalize(repoRoot);
  const rel = path.relative(normalizedRoot, normalizedAbs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return rel.replace(/\\/g, '/');
}

function classifyFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (PDF_EXTENSIONS.has(ext)) return 'pdf';
  if (BINARY_DOC_EXTENSIONS.has(ext)) return 'document';
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive';
  return 'text';
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.tiff': 'image/tiff', '.tif': 'image/tiff',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

function readTextFilePreview(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) {
      return { success: false, error: '파일을 찾을 수 없습니다.' };
    }

    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
      return { success: false, error: '파일 경로가 올바르지 않습니다.' };
    }

    const readBytes = Math.min(stat.size, MAX_FILE_IMPORT_BYTES);
    const fd = fs.openSync(targetPath, 'r');
    const buffer = Buffer.alloc(readBytes);

    try {
      fs.readSync(fd, buffer, 0, readBytes, 0);
    } finally {
      fs.closeSync(fd);
    }

    if (buffer.includes(0)) {
      return { success: false, error: '텍스트 파일만 불러올 수 있습니다.' };
    }

    return {
      success: true,
      path: targetPath,
      fileType: 'text',
      content: buffer.toString('utf8'),
      size: stat.size,
      truncated: stat.size > MAX_FILE_IMPORT_BYTES,
      maxBytes: MAX_FILE_IMPORT_BYTES,
    };
  } catch (error) {
    return { success: false, error: error.message || '파일을 읽는 중 오류가 발생했습니다.' };
  }
}

function readFileGeneric(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) {
      return { success: false, error: '파일을 찾을 수 없습니다.' };
    }

    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
      return { success: false, error: '파일 경로가 올바르지 않습니다.' };
    }

    const fileType = classifyFileType(targetPath);
    const mimeType = getMimeType(targetPath);
    const fileName = path.basename(targetPath);

    if (fileType === 'image') {
      if (stat.size > MAX_IMAGE_IMPORT_BYTES) {
        return { success: false, error: `이미지 파일이 너무 큽니다. (최대 ${Math.round(MAX_IMAGE_IMPORT_BYTES / 1024 / 1024)}MB)` };
      }
      const raw = fs.readFileSync(targetPath);
      const base64 = raw.toString('base64');
      const dataUrl = `data:${mimeType};base64,${base64}`;
      return {
        success: true,
        path: targetPath,
        fileName,
        fileType: 'image',
        mimeType,
        base64,
        dataUrl,
        size: stat.size,
        truncated: false,
      };
    }

    if (fileType === 'pdf') {
      if (stat.size > MAX_PDF_IMPORT_BYTES) {
        return { success: false, error: `PDF 파일이 너무 큽니다. (최대 ${Math.round(MAX_PDF_IMPORT_BYTES / 1024 / 1024)}MB)` };
      }
      const raw = fs.readFileSync(targetPath);
      const base64 = raw.toString('base64');
      return {
        success: true,
        path: targetPath,
        fileName,
        fileType: 'pdf',
        mimeType,
        base64,
        size: stat.size,
        truncated: false,
      };
    }

    if (fileType === 'document' || fileType === 'archive') {
      return {
        success: true,
        path: targetPath,
        fileName,
        fileType,
        mimeType,
        size: stat.size,
        truncated: false,
        content: `[${fileType === 'archive' ? '압축' : '문서'} 파일] ${fileName} (${formatFileSizeLabel(stat.size)})`,
      };
    }

    // 텍스트 파일 (기본)
    return readTextFilePreview(targetPath);
  } catch (error) {
    return { success: false, error: error.message || '파일을 읽는 중 오류가 발생했습니다.' };
  }
}

function readFilesGeneric(filePaths, limit = 10) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return { success: false, error: '파일 경로가 없습니다.', files: [] };
  }

  const results = [];
  for (const fp of filePaths.slice(0, limit)) {
    const resolved = resolveFilePath(fp) || fp;
    if (path.relative(workingDirectory, resolved).startsWith('..')) {
      results.push({ success: false, error: '작업 디렉토리 밖의 파일에 접근할 수 없습니다.', name: fp });
      continue;
    }
    results.push(readFileGeneric(resolved));
  }

  const successCount = results.filter(item => item?.success).length;
  return {
    success: successCount > 0,
    error: successCount > 0 ? '' : (results[0]?.error || '파일을 불러오지 못했습니다.'),
    files: results,
    limit,
    selectionLimited: filePaths.length > limit,
  };
}

function formatFileSizeLabel(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// --- 작업 디렉토리 관리 ---
let workingDirectory = os.homedir();

function resolveInitialCwd() {
  // 1순위: --cwd 명령줄 인자
  const args = process.argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cwd' && args[i + 1]) {
      const dir = args[i + 1];
      if (fs.existsSync(dir)) return dir;
    }
    if (args[i].startsWith('--cwd=')) {
      const dir = args[i].slice(6);
      if (fs.existsSync(dir)) return dir;
    }
  }

  // 2순위: 마지막 인자가 존재하는 폴더 경로이면 사용
  const lastArg = args[args.length - 1];
  if (lastArg && !lastArg.startsWith('-')) {
    try {
      const stat = fs.statSync(lastArg);
      if (stat.isDirectory()) return lastArg;
    } catch { /* ignore */ }
  }

  return os.homedir();
}

function createWindow() {
  workingDirectory = resolveInitialCwd();

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1100, Math.floor(width * 0.7)),
    height: Math.min(850, Math.floor(height * 0.85)),
    minWidth: 500,
    minHeight: 400,
    frame: false,
    transparent: false,
    backgroundColor: '#0C0C1E',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 렌더러 로그 캡처
  mainWindow.webContents.on('console-message', (e, level, msg, line, src) => {
    const tag = ['LOG', 'WARN', 'ERR'][level] || 'LOG';
    console.log(`[R:${tag}] ${msg}`);
  });

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window:maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window:maximized', false);
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') mainWindow.webContents.toggleDevTools();
    if (input.key === 'F11') mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('closed', () => {
    if (manualWindow && !manualWindow.isDestroyed()) {
      manualWindow.close();
    }
    manualWindow = null;
    for (const [, handle] of runningProcesses) {
      try { handle.kill(); } catch (e) { /* ignore */ }
    }
    runningProcesses.clear();
    mainWindow = null;
  });
}

function openManualWindow() {
  if (manualWindow && !manualWindow.isDestroyed()) {
    if (manualWindow.isMinimized()) manualWindow.restore();
    manualWindow.focus();
    return { success: true };
  }

  manualWindow = new BrowserWindow({
    width: 920,
    height: 760,
    minWidth: 680,
    minHeight: 500,
    parent: mainWindow || undefined,
    autoHideMenuBar: true,
    backgroundColor: '#101122',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  manualWindow.loadFile(path.join(__dirname, 'renderer', 'manual.html'));
  manualWindow.once('ready-to-show', () => manualWindow?.show());
  manualWindow.on('closed', () => {
    manualWindow = null;
  });

  return { success: true };
}

// --- CLI 경로 자동 탐색 ---
function resolveCliPath(command) {
  // 이미 절대 경로면 그대로
  if (command.includes('\\') || command.includes('/')) {
    if (fs.existsSync(command)) return command;
    if (fs.existsSync(command + '.cmd')) return command + '.cmd';
    if (fs.existsSync(command + '.exe')) return command + '.exe';
    return command;
  }

  // 캐시 확인
  if (resolvedCliPaths[command]) {
    if (fs.existsSync(resolvedCliPaths[command])) return resolvedCliPaths[command];
    delete resolvedCliPaths[command];
  }

  const isWin = process.platform === 'win32';
  const extensions = isWin ? ['.cmd', '.exe', ''] : [''];
  const candidates = [];

  // 1. npm global 경로 (npm prefix -g)
  try {
    const npmGlobal = execSync('npm prefix -g', { encoding: 'utf8', timeout: 5000 }).trim();
    if (npmGlobal) {
      for (const ext of extensions) {
        candidates.push(path.join(npmGlobal, command + ext));
        if (isWin) candidates.push(path.join(npmGlobal, 'node_modules', '.bin', command + ext));
      }
    }
  } catch { /* ignore */ }

  // 2. %APPDATA%\npm (Windows npm global 기본 경로)
  if (isWin) {
    const appData = process.env.APPDATA;
    if (appData) {
      for (const ext of extensions) {
        candidates.push(path.join(appData, 'npm', command + ext));
      }
    }
  }

  // 3. nvm / fnm / volta 등 버전 관리자 경로
  const homedir = os.homedir();
  const extraDirs = isWin
    ? [
        path.join(homedir, '.nvm', 'versions'),
        path.join(homedir, 'scoop', 'shims'),
        path.join(homedir, 'scoop', 'apps', 'nodejs', 'current'),
        path.join(homedir, '.volta', 'bin'),
        path.join(homedir, '.fnm', 'node-versions'),
      ]
    : [
        path.join(homedir, '.nvm', 'versions'),
        path.join(homedir, '.volta', 'bin'),
        path.join(homedir, '.fnm', 'node-versions'),
        '/usr/local/bin',
        '/usr/bin',
      ];

  for (const dir of extraDirs) {
    for (const ext of extensions) {
      candidates.push(path.join(dir, command + ext));
    }
  }

  // 4. PATH 환경변수에서 직접 탐색
  const pathDirs = (process.env.PATH || '').split(isWin ? ';' : ':');
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const ext of extensions) {
      candidates.push(path.join(dir, command + ext));
    }
  }

  // 후보 중 실제 존재하는 첫 번째 반환
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        console.log(`[CLI] resolved '${command}' → ${candidate}`);
        resolvedCliPaths[command] = candidate;
        return candidate;
      }
    } catch { /* ignore */ }
  }

  // 못 찾으면 원래 이름 + .cmd (기존 동작)
  console.log(`[CLI] could not resolve '${command}', falling back to '${command}.cmd'`);
  return isWin ? `${command}.cmd` : command;
}

function createProcessHandle(kind, proc) {
  return {
    kind: 'spawn',
    proc,
    write(data) {
      if (!proc || !proc.stdin || proc.stdin.destroyed) return;
      try { proc.stdin.write(String(data || '')); } catch { /* ignore */ }
    },
    kill() {
      if (!proc) return;
      try {
        if (proc.stdin && !proc.stdin.destroyed) proc.stdin.end();
      } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
    },
  };
}

function sanitizeCliEnv(rawEnv) {
  const source = { ...(rawEnv || {}) };
  const env = {};
  const allow = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'WINDIR',
    'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
    'OS', 'USERNAME', 'USERDOMAIN',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
    'TERM', 'WT_SESSION', 'LANG', 'LC_ALL',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
    'ANTHROPIC_API_KEY',
  ]);

  for (const [key, value] of Object.entries(source)) {
    const upper = String(key || '').toUpperCase();
    if (!allow.has(upper)) continue;
    env[key] = value;
  }
  return env;
}

function formatCliArgsForLog(args, maxLen = 160) {
  return (Array.isArray(args) ? args : []).map((arg) => {
    const value = String(arg ?? '');
    return value.length > maxLen
      ? `${value.slice(0, maxLen)}... (${value.length} chars)`
      : value;
  });
}

// Claude stream-json 이벤트 처리
function handleClaudeStreamEvent(id, evt) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const send = (data) => mainWindow.webContents.send('cli:stream', { id, ...data });

  // 시스템 초기화
  if (evt.type === 'system' && evt.subtype === 'init') {
    send({
      type: 'system-init',
      chunk: JSON.stringify({ sessionId: evt.session_id, model: evt.model, tools: evt.tools }),
      sessionId: evt.session_id,
      model: evt.model,
      tools: evt.tools,
    });
    return;
  }

  // 어시스턴트 응답 (thinking, text, tool_use 블록 포함)
  if (evt.type === 'assistant') {
    const msg = evt.message;
    if (!msg || !msg.content) return;

    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        send({ type: 'stdout', chunk: block.text });
      } else if (block.type === 'thinking' && block.thinking) {
        send({ type: 'thinking', chunk: block.thinking });
      } else if (block.type === 'tool_use') {
        const toolSummary = `${block.name}(${JSON.stringify(block.input).slice(0, 200)})`;
        send({ type: 'tool-use', chunk: toolSummary, toolName: block.name, toolInput: block.input, toolId: block.id });
      }
    }

    if (msg.usage) {
      send({ type: 'usage', chunk: JSON.stringify(msg.usage), usage: msg.usage });
    }
    return;
  }

  // 유저 메시지 (tool_result 포함)
  if (evt.type === 'user') {
    const msg = evt.message;
    if (!msg || !msg.content) return;
    const contents = Array.isArray(msg.content) ? msg.content : [msg.content];
    for (const block of contents) {
      if (block.type === 'tool_result') {
        const resultStr = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
        send({ type: 'tool-result', chunk: resultStr.slice(0, 500), toolId: block.tool_use_id, content: block.content });
      }
    }
    return;
  }

  // tool_result (최상위 레벨)
  if (evt.type === 'tool_result') {
    const resultStr = typeof evt.content === 'string' ? evt.content : JSON.stringify(evt.content || '');
    send({ type: 'tool-result', chunk: resultStr.slice(0, 500), toolId: evt.tool_use_id, content: evt.content });
    return;
  }

  // Rate limit
  if (evt.type === 'rate_limit_event') {
    lastRateLimitInfo = evt.rate_limit_info;
    send({ type: 'rate-limit', chunk: JSON.stringify(evt.rate_limit_info), rateLimitInfo: evt.rate_limit_info });
    return;
  }

  // 최종 결과
  if (evt.type === 'result') {
    // 세션 누적 사용량 업데이트
    if (evt.total_cost_usd) sessionUsage.totalCostUsd += Number(evt.total_cost_usd) || 0;
    if (evt.usage) {
      sessionUsage.inputTokens += Number(evt.usage.input_tokens) || 0;
      sessionUsage.outputTokens += Number(evt.usage.output_tokens) || 0;
      sessionUsage.cacheRead += Number(evt.usage.cache_read_input_tokens) || 0;
      sessionUsage.cacheCreate += Number(evt.usage.cache_creation_input_tokens) || 0;
      sessionUsage.totalTokens = sessionUsage.inputTokens + sessionUsage.outputTokens + sessionUsage.cacheRead + sessionUsage.cacheCreate;
    }
    sessionUsage.turnCount++;
    send({
      type: 'result',
      chunk: JSON.stringify({ cost_usd: evt.total_cost_usd, session_id: evt.session_id, duration_ms: evt.duration_ms }),
      result: evt.result,
      cost: evt.total_cost_usd,
      duration: evt.duration_ms,
      usage: evt.usage,
      modelUsage: evt.modelUsage,
      sessionUsage: { ...sessionUsage },
      sessionId: evt.session_id,
    });
    mainWindow.webContents.send('cli:turnDone', { id });
    return;
  }

  // 미인식 이벤트도 renderer에 raw로 전달 (승인 요청 등 누락 방지)
  send({ type: 'raw-event', chunk: JSON.stringify(evt), rawEvent: evt });
}

// --- CLI 실행 (child_process.spawn 기반) ---
ipcMain.handle('cli:run', (event, { id, profile, prompt, cwd }) => {
  const promptText = typeof prompt === 'string' ? prompt : '';
  const runCwd = cwd || workingDirectory;
  const baseArgs = [...(profile.args || [])];

  // Build claude args
  const hasOutputFormat = baseArgs.some(a => a === '--output-format');
  const args = ['-p', '--verbose', ...(hasOutputFormat ? [] : ['--output-format', 'stream-json']), ...baseArgs];
  if (promptText) {
    args.push('--', promptText);
  }

  console.log(`[CLI] run id=${id} shell=${profile.command} prompt=${promptText ? `${promptText.length} chars` : 'none'} args=${JSON.stringify(formatCliArgsForLog(args))} cwd=${runCwd}`);

  try {
    const env = { ...process.env, ...(profile.env || {}), CLAUDECODE: '' };
    const resolvedShell = resolveCliPath(profile.command);

    const child = spawn(resolvedShell, args, {
      cwd: runCwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    runningProcesses.set(id, createProcessHandle('spawn', child));

    // stdin을 즉시 닫아 -p 모드에서 프롬프트 처리가 시작되도록 함
    child.stdin?.end();

    let lineBuf = '';

    child.stdout?.on('data', (data) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      lineBuf += text;

      const lines = lineBuf.split('\n');
      lineBuf = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          handleClaudeStreamEvent(id, evt);
        } catch {
          // non-JSON output, send as raw
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('cli:stream', { id, chunk: line + '\n', type: 'stdout' });
          }
        }
      }
    });

    child.stderr?.on('data', (data) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      if (!text || !mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('cli:stream', { id, chunk: text, type: 'stderr' });
    });

    child.on('error', (err) => {
      console.log(`[CLI] error id=${id} err=${err.message}`);
      runningProcesses.delete(id);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cli:error', { id, error: err.message });
      }
    });

    child.on('close', (code) => {
      // flush remaining buffer
      if (lineBuf.trim()) {
        try {
          const evt = JSON.parse(lineBuf);
          handleClaudeStreamEvent(id, evt);
        } catch {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('cli:stream', { id, chunk: lineBuf, type: 'stdout' });
          }
        }
      }
      const exitCode = Number.isFinite(code) ? code : 0;
      console.log(`[CLI] exit id=${id} code=${exitCode}`);
      runningProcesses.delete(id);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cli:done', { id, code: exitCode });
      }
    });

    // 즉시 반환 - 스트리밍은 이벤트로 처리
    return { success: true, id };

  } catch (err) {
    console.log(`[CLI] error id=${id} err=${err.message}`);
    return { success: false, error: err.message };
  }
});

// CLI 프로세스에 입력 전송
ipcMain.handle('cli:write', (event, { id, data }) => {
  const handle = runningProcesses.get(id);
  if (handle) {
    handle.write(data);
    return { success: true };
  }
  return { success: false };
});

// CLI 프로세스 중지
ipcMain.handle('cli:stop', (event, { id }) => {
  const handle = runningProcesses.get(id);
  if (handle) {
    try { handle.kill(); } catch {}
    runningProcesses.delete(id);
    return { success: true };
  }
  return { success: false };
});

// --- 작업 디렉토리 ---
ipcMain.handle('cwd:get', () => workingDirectory);

ipcMain.handle('cwd:set', (event, dir) => {
  if (fs.existsSync(dir)) {
    workingDirectory = dir;
    return { success: true, cwd: dir };
  }
  return { success: false, error: 'Directory not found' };
});

ipcMain.handle('cwd:select', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '작업 폴더 선택',
    defaultPath: workingDirectory,
    properties: ['openDirectory'],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    workingDirectory = result.filePaths[0];
    return { success: true, cwd: workingDirectory };
  }
  return { success: false };
});

ipcMain.handle('file:pickAndRead', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '불러올 파일 선택',
    defaultPath: workingDirectory,
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '모든 지원 파일', extensions: ['txt', 'md', 'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'html', 'css', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'sh', 'bat', 'ps1', 'sql', 'r', 'swift', 'kt', 'scala', 'lua', 'pl', 'pm', 'vue', 'svelte', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff', 'tif', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'log', 'env'] },
      { name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff', 'tif'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: '문서', extensions: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'] },
      { name: '텍스트/코드', extensions: ['txt', 'md', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'json', 'xml', 'yaml', 'yml', 'html', 'css', 'sql', 'sh', 'bat', 'csv', 'log'] },
      { name: '모든 파일', extensions: ['*'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, canceled: true, error: '파일 선택이 취소되었습니다.' };
  }

  return readFilesGeneric(result.filePaths);
});

ipcMain.handle('file:read', (event, { filePath }) => {
  const resolvedPath = resolveFilePath(filePath);
  if (!resolvedPath) {
    return { success: false, error: '파일 경로를 입력하세요.' };
  }
  if (path.relative(workingDirectory, resolvedPath).startsWith('..')) {
    return { success: false, error: '작업 디렉토리 밖의 파일에 접근할 수 없습니다.' };
  }
  return readFileGeneric(resolvedPath);
});

// 드래그 앤 드롭으로 받은 파일 경로 배열을 일괄 읽기
ipcMain.handle('file:readMultiple', (event, { filePaths }) => {
  return readFilesGeneric(filePaths);
});

ipcMain.handle('file:open', async (event, { filePath }) => {
  const { resolvedPath, line } = resolveOpenFileTarget(filePath);
  if (!resolvedPath) {
    return { success: false, error: '파일 경로를 입력하세요.' };
  }

  try {
    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: '파일을 찾을 수 없습니다.' };
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      return { success: false, error: '파일 경로가 올바르지 않습니다.' };
    }

    const openError = await shell.openPath(resolvedPath);
    if (openError) {
      return { success: false, error: openError };
    }

    return { success: true, path: resolvedPath, line };
  } catch (error) {
    return { success: false, error: error.message || '파일을 여는 중 오류가 발생했습니다.' };
  }
});

// --- 커밋 메시지 자동 생성 (claude CLI 활용) ---
ipcMain.handle('repo:generateCommitMessage', async (event, arg) => {
  try {
    const cwd = (typeof arg?.cwd === 'string' && arg.cwd.trim()) ? arg.cwd.trim() : workingDirectory;
    const rootResult = await runGitCommandAsync(['rev-parse', '--show-toplevel'], cwd);
    if (!rootResult.ok) return { success: false, error: 'git repository not found' };
    const repoRoot = rootResult.stdout.trim();

    // diff 수집 (staged + unstaged + untracked)
    const [stagedDiff, unstagedDiff, untrackedFiles] = await Promise.all([
      runGitCommandAsync(['diff', '--cached', '--no-color', '--stat'], repoRoot),
      runGitCommandAsync(['diff', '--no-color', '--stat'], repoRoot),
      runGitCommandAsync(['ls-files', '--others', '--exclude-standard'], repoRoot),
    ]);
    const [stagedDetail, unstagedDetail] = await Promise.all([
      runGitCommandAsync(['diff', '--cached', '--no-color'], repoRoot),
      runGitCommandAsync(['diff', '--no-color'], repoRoot),
    ]);

    let diffSummary = '';
    if (stagedDiff.ok && stagedDiff.stdout.trim()) diffSummary += `[Staged]\n${stagedDiff.stdout.trim()}\n`;
    if (unstagedDiff.ok && unstagedDiff.stdout.trim()) diffSummary += `[Unstaged]\n${unstagedDiff.stdout.trim()}\n`;
    if (untrackedFiles.ok && untrackedFiles.stdout.trim()) diffSummary += `[New files]\n${untrackedFiles.stdout.trim()}\n`;

    // 상세 diff (최대 4000자)
    let detailDiff = '';
    if (stagedDetail.ok && stagedDetail.stdout.trim()) detailDiff += stagedDetail.stdout.trim() + '\n';
    if (unstagedDetail.ok && unstagedDetail.stdout.trim()) detailDiff += unstagedDetail.stdout.trim() + '\n';
    if (detailDiff.length > 4000) detailDiff = detailDiff.slice(0, 4000) + '\n...(truncated)';

    if (!diffSummary.trim() && !detailDiff.trim()) {
      return { success: false, error: 'no changes to commit' };
    }

    // claude CLI로 커밋 메시지 생성
    const prompt = `Based on the following git diff, generate a concise git commit message in Korean.
Rules:
- First line: short summary (max 72 chars)
- If needed, add a blank line then bullet points for details
- Focus on WHAT changed and WHY, not HOW
- Do NOT include any explanation or prefix, output ONLY the commit message itself

Diff summary:
${diffSummary}

Diff detail:
${detailDiff}`;

    const claudePath = resolveCliPath('claude');
    if (!claudePath) return { success: false, error: 'claude CLI not found' };

    return new Promise((resolve) => {
      const execArgs = ['-p', '--output-format', 'json', '--model', 'haiku', '--', prompt];

      const spawnOptions = {
        cwd: repoRoot,
        env: { ...process.env, CLAUDECODE: '' },
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      };

      const child = spawn(claudePath, execArgs, spawnOptions);
      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (d) => { stdout += d.toString('utf8'); });
      child.stderr?.on('data', (d) => { stderr += d.toString('utf8'); });

      child.on('close', () => {
        // JSON 결과 파싱 → result 필드 추출
        let message = '';
        try {
          const parsed = JSON.parse(stdout.trim());
          // 배열인 경우 (--verbose 등) 마지막에서 result 찾기
          if (Array.isArray(parsed)) {
            for (let i = parsed.length - 1; i >= 0; i--) {
              if (parsed[i]?.result) { message = parsed[i].result.trim(); break; }
            }
          } else if (parsed?.result) {
            message = parsed.result.trim();
          }
        } catch {
          // JSONL 형태일 수 있으므로 마지막 줄 시도
          const lines = stdout.trim().split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const obj = JSON.parse(lines[i]);
              if (obj?.result) {
                message = obj.result.trim();
                break;
              }
            } catch {}
          }
        }
        if (!message) {
          resolve({ success: false, error: stderr.trim() || 'no message generated' });
        } else {
          resolve({ success: true, message });
        }
      });

      child.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// --- Git 상태 조회 ---
ipcMain.handle('repo:getStatus', async (event, arg) => {
  try {
    const cwd = (typeof arg?.cwd === 'string' && arg.cwd.trim()) ? arg.cwd.trim() : workingDirectory;
    const rootResult = await runGitCommandAsync(['rev-parse', '--show-toplevel'], cwd);
    if (!rootResult.ok) return { success: false, error: 'git repository not found' };
    const repoRoot = rootResult.stdout.trim();

    // 변경 파일 목록
    const statusResult = await runGitCommandAsync(['status', '--porcelain'], repoRoot);
    if (!statusResult.ok) return { success: false, error: statusResult.stderr || 'git status failed' };

    const files = [];
    for (const line of statusResult.stdout.split(/\r?\n/)) {
      if (!line || line.length < 4) continue;
      const status = line.slice(0, 2).trim();
      const filePath = line.slice(3).trim();
      if (filePath) files.push({ status, file: filePath });
    }

    // 최근 커밋 메시지 (스타일 참고용)
    const logResult = await runGitCommandAsync(['log', '--oneline', '-5'], repoRoot);
    const recentCommits = logResult.ok
      ? logResult.stdout.trim().split(/\r?\n/).filter(l => l.trim()).map(l => l.trim())
      : [];

    // diff 요약 (staged + unstaged)
    const diffStatResult = await runGitCommandAsync(['diff', '--stat', '--no-color'], repoRoot);
    const stagedStatResult = await runGitCommandAsync(['diff', '--cached', '--stat', '--no-color'], repoRoot);

    return {
      success: true,
      repoRoot,
      files,
      recentCommits,
      diffStat: (stagedStatResult.ok ? stagedStatResult.stdout.trim() : '') + '\n' + (diffStatResult.ok ? diffStatResult.stdout.trim() : ''),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// --- Git 커밋 ---
ipcMain.handle('repo:commit', async (event, arg) => {
  try {
    const cwd = (typeof arg?.cwd === 'string' && arg.cwd.trim()) ? arg.cwd.trim() : workingDirectory;
    const message = typeof arg?.message === 'string' ? arg.message.trim() : '';
    if (!message) return { success: false, error: '커밋 메시지가 비어있습니다.' };

    const rootResult = await runGitCommandAsync(['rev-parse', '--show-toplevel'], cwd);
    if (!rootResult.ok) return { success: false, error: 'git repository not found' };
    const repoRoot = rootResult.stdout.trim();

    // 추적 중인 파일의 변경 사항만 stage (untracked 파일 제외)
    const addResult = await runGitCommandAsync(['add', '-u'], repoRoot);
    if (!addResult.ok) return { success: false, error: `git add failed: ${addResult.stderr}` };

    // staged 파일 확인
    const stagedResult = await runGitCommandAsync(['diff', '--cached', '--name-only'], repoRoot);
    if (!stagedResult.ok || !stagedResult.stdout.trim()) {
      return { success: false, error: '커밋할 변경 사항이 없습니다.' };
    }

    // 커밋 실행
    const commitResult = await runGitCommandAsync(['commit', '-m', message], repoRoot);
    if (!commitResult.ok) return { success: false, error: commitResult.stderr || 'git commit failed' };

    // 커밋 해시
    const hashResult = await runGitCommandAsync(['rev-parse', '--short', 'HEAD'], repoRoot);
    const hash = hashResult.ok ? hashResult.stdout.trim() : '';

    return {
      success: true,
      hash,
      message,
      output: commitResult.stdout.trim(),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('repo:getFileDiffs', async (event, arg) => {
  try {
    const requestedCwd = typeof arg?.cwd === 'string' && arg.cwd.trim()
      ? arg.cwd.trim()
      : workingDirectory;
    const files = Array.isArray(arg?.files) ? arg.files : [];

    const cwd = fs.existsSync(requestedCwd) ? requestedCwd : workingDirectory;
    const rootResult = await runGitCommandAsync(['rev-parse', '--show-toplevel'], cwd);
    if (!rootResult.ok) {
      return { success: false, error: 'git repository not found', data: [] };
    }
    const repoRoot = rootResult.stdout.trim();
    if (!repoRoot) {
      return { success: false, error: 'git repository root not resolved', data: [] };
    }

    const normalizedFiles = [];
    const seen = new Set();
    const pushRelativePath = (relPath) => {
      const rel = String(relPath || '').trim().replace(/\\/g, '/');
      if (!rel || seen.has(rel)) return;
      seen.add(rel);
      normalizedFiles.push(rel);
    };

    if (files.length > 0) {
      for (const file of files) {
        const rel = normalizeRepoFilePath(file, repoRoot, cwd);
        if (!rel) continue;
        pushRelativePath(rel);
      }
    } else {
      const changedCommands = [
        ['diff', '--no-color', '--name-only', '--cached'],
        ['diff', '--no-color', '--name-only'],
        ['ls-files', '--others', '--exclude-standard'],
      ];
      for (const command of changedCommands) {
        const result = await runGitCommandAsync(command, repoRoot);
        if (!result.ok || !result.stdout) continue;
        for (const line of result.stdout.split(/\r?\n/)) {
          const rel = String(line || '').trim();
          if (!rel) continue;
          pushRelativePath(rel);
        }
      }
    }

    const data = [];
    for (const rel of normalizedFiles) {
      const [staged, unstaged] = await Promise.all([
        runGitCommandAsync(['diff', '--no-color', '--cached', '--', rel], repoRoot),
        runGitCommandAsync(['diff', '--no-color', '--', rel], repoRoot),
      ]);
      let diffText = '';
      if (staged.ok && staged.stdout.trim()) diffText += `${staged.stdout.trim()}\n`;
      if (unstaged.ok && unstaged.stdout.trim()) diffText += `${unstaged.stdout.trim()}\n`;

      if (!diffText.trim()) {
        const untracked = await runGitCommandAsync(['ls-files', '--others', '--exclude-standard', '--', rel], repoRoot);
        const isUntracked = untracked.ok && untracked.stdout
          .split(/\r?\n/)
          .map(line => line.trim().replace(/\\/g, '/'))
          .some(line => line === rel);
        if (isUntracked) {
          const abs = path.join(repoRoot, rel);
          let stat = null;
          try {
            stat = await fs.promises.stat(abs);
          } catch {
            stat = null;
          }
          if (stat?.isFile()) {
            let content = '';
            try {
              content = await fs.promises.readFile(abs, 'utf8');
            } catch {
              content = '';
            }
            if (!content) continue;
            const bodyLines = content.split(/\r?\n/);
            const plusLines = bodyLines.map(line => `+${line}`).join('\n');
            diffText = [
              `diff --git a/${rel} b/${rel}`,
              'new file mode 100644',
              '--- /dev/null',
              `+++ b/${rel}`,
              `@@ -0,0 +1,${bodyLines.length} @@`,
              plusLines,
            ].join('\n');
          }
        }
      }

      const trimmed = diffText.trim();
      if (!trimmed) continue;
      data.push({ file: rel, diff: trimmed });
    }

    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message || 'diff collection failed', data: [] };
  }
});

// --- Codex 세션 diff 추출 (stub) ---
ipcMain.handle('codex:getSessionDiffs', async (event, arg) => {
  // TODO: Claude CLI uses different session storage; implement when needed
  return { success: false, error: 'not implemented for Claude CLI', data: [] };
});

// 윈도우 컨트롤
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow) {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  }
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);
ipcMain.handle('help:openManual', () => {
  try {
    return openManualWindow();
  } catch (error) {
    return { success: false, error: error.message || '사용 설명서를 열지 못했습니다.' };
  }
});

// --- PTY 기반 /usage 데이터 가져오기 ---
function fetchUsageViaPty() {
  if (usageFetchInProgress) {
    return Promise.resolve(cachedUsageData);
  }
  usageFetchInProgress = true;
  return new Promise((resolve) => {
    let pty;
    try {
      pty = require('@lydell/node-pty');
    } catch (e) {
      usageFetchInProgress = false;
      resolve(null);
      return;
    }
    const claudePath = resolveCliPath('claude');
    if (!claudePath) {
      usageFetchInProgress = false;
      resolve(null);
      return;
    }
    let output = '';
    let shell;
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      usageFetchInProgress = false;
      try { shell.kill(); } catch (_) {}
      // ANSI 제거 후 파싱 - [nC 커서 이동은 공백으로 치환
      const clean = output
        .replace(/\x1b\[\d*C/g, ' ')
        .replace(/\x1b\[[0-9;]*[a-zA-ZH]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\x1b\[\?[0-9;]*[hl]/g, '')
        .replace(/\x1b[>=>\[>][0-9]*[a-zA-Z]?/g, '')
        .replace(/\x1b\([A-Z0-9]/g, '');
      const result = parseUsageText(clean);
      if (result) cachedUsageData = result;
      resolve(cachedUsageData);
    };
    try {
      shell = pty.spawn(claudePath, [], {
        name: 'xterm', cols: 120, rows: 30,
        cwd: workingDirectory || process.cwd(),
        env: process.env,
      });
      shell.onData(d => { output += d; });
      // 6초 후 /usage 전송
      setTimeout(() => { try { shell.write('/usage\r'); } catch (_) {} }, 5000);
      // usage 데이터 감지
      const checkInterval = setInterval(() => {
        if (output.includes('% used') && (output.includes('Extra usage') || output.includes('Current week'))) {
          clearInterval(checkInterval);
          setTimeout(finish, 2000);
        }
      }, 300);
      // 최대 20초 타임아웃
      setTimeout(() => { clearInterval(checkInterval); finish(); }, 20000);
    } catch (e) {
      usageFetchInProgress = false;
      resolve(null);
    }
  });
}

function parseUsageText(text) {
  const result = {};
  // 섹션별로 분리: "Current session", "Current week (all models)", "Current week (Sonnet only)", "Extra usage"
  const sections = text.split(/(Current session|Current week \(all models\)|Current week \(Sonnet only\)|Extra usage)/i);
  for (let i = 1; i < sections.length; i += 2) {
    const header = sections[i];
    const body = sections[i + 1] || '';
    const pctMatch = body.match(/(\d+)%\s*used/);
    const resetMatch = body.match(/Resets?\s+(.*?\(.*?\))/i);
    if (header.match(/Current session/i)) {
      if (pctMatch) result.sessionPercent = parseInt(pctMatch[1]);
      if (resetMatch) result.sessionResetsAt = resetMatch[1].trim();
    } else if (header.match(/Current week \(all models\)/i)) {
      if (pctMatch) result.weekAllPercent = parseInt(pctMatch[1]);
      if (resetMatch) result.weekAllResetsAt = resetMatch[1].trim();
    } else if (header.match(/Current week \(Sonnet only\)/i)) {
      if (pctMatch) result.weekSonnetPercent = parseInt(pctMatch[1]);
      if (resetMatch) result.weekSonnetResetsAt = resetMatch[1].trim();
    } else if (header.match(/Extra usage/i)) {
      if (body.includes('not enabled')) result.extraUsage = 'not_enabled';
    }
  }

  if (Object.keys(result).length === 0) return null;
  result.fetchedAt = Date.now();
  return result;
}

// --- Claude rate limits (스트림에서 수신한 캐시 + PTY usage) ---
ipcMain.handle('codex:rateLimits', async () => {
  const resetsAtMs = lastRateLimitInfo?.resetsAt
    ? (lastRateLimitInfo.resetsAt > 1e12 ? lastRateLimitInfo.resetsAt : lastRateLimitInfo.resetsAt * 1000)
    : null;
  // PTY usage 캐시가 없거나 5분 이상 지났으면 갱신
  const stale = !cachedUsageData || (Date.now() - (cachedUsageData.fetchedAt || 0)) > 5 * 60 * 1000;
  if (stale) {
    await fetchUsageViaPty(); // 캐시 없으면 대기
  }
  return {
    success: true,
    rateLimitType: lastRateLimitInfo?.rateLimitType || 'five_hour',
    status: lastRateLimitInfo?.status || 'unknown',
    h5ResetsAt: resetsAtMs,
    sessionUsage: { ...sessionUsage },
    usageData: cachedUsageData ? { ...cachedUsageData } : null,
  };
});

// --- 서브에이전트: .claude/agents/*.md 파일 읽기 ---
ipcMain.handle('codex:listAgents', (event, arg) => {
  try {
    const rawCwd = typeof arg === 'string' ? arg : (typeof arg?.cwd === 'string' ? arg.cwd : '');
    const projectCwd = rawCwd && rawCwd.trim() ? rawCwd.trim() : workingDirectory;
    const agents = [];

    // 1순위: 현재 대화 프로젝트 폴더의 .claude/agents/
    // 2순위: 글로벌 ~/.claude/agents/
    const projectAgentsDir = path.join(projectCwd, '.claude', 'agents');
    const globalAgentsDir = path.join(os.homedir(), '.claude', 'agents');
    const searchDirs = [projectAgentsDir, globalAgentsDir];

    const seenNames = new Set();
    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(dir, file), 'utf8');
          const agentName = file.replace(/\.md$/i, '');
          if (seenNames.has(agentName)) continue;
          seenNames.add(agentName);
          agents.push({
            name: agentName,
            description: '',
            developer_instructions: content,
            model: '',
            sandbox_mode: '',
            source: dir === projectAgentsDir ? 'project' : 'global',
            fileName: file,
          });
        } catch { /* skip malformed files */ }
      }
    }
    return { success: true, data: agents };
  } catch (err) {
    return { success: false, error: err.message, data: [] };
  }
});

// --- Claude 세션 목록 (stub) ---
ipcMain.handle('codex:listSessions', (event, limitArg) => {
  // TODO: Claude CLI session management uses --resume/--continue flags.
  // Session listing from ~/.claude/projects/ can be implemented later.
  return { success: true, data: [] };
});

// --- Claude 세션 대화 복원 (stub) ---
ipcMain.handle('codex:loadSession', (event, arg) => {
  // TODO: Implement Claude session loading when needed
  return { success: false, error: 'not implemented for Claude CLI' };
});

ipcMain.handle('codex:deleteSession', (event, arg) => {
  // TODO: Implement Claude session deletion when needed
  return { success: false, error: 'not implemented for Claude CLI' };
});

// 시스템 정보
ipcMain.handle('system:info', () => ({
  platform: process.platform,
  username: os.userInfo().username,
  homedir: os.homedir(),
  appVersion: app.getVersion(),
  electronVersion: process.versions.electron,
}));

// --- 대화 데이터 파일 기반 저장/로드 ---
function getConversationsPath() {
  return path.join(app.getPath('userData'), 'conversations.json');
}

ipcMain.handle('store:loadConversations', () => {
  try {
    const filePath = getConversationsPath();
    if (!fs.existsSync(filePath)) return { success: true, data: [] };
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return { success: true, data: Array.isArray(parsed) ? parsed : [] };
  } catch (err) {
    console.error('[store] loadConversations error:', err.message);
    return { success: false, data: [], error: err.message };
  }
});

ipcMain.handle('store:saveConversations', (event, data) => {
  try {
    const filePath = getConversationsPath();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 0), 'utf8');
    return { success: true };
  } catch (err) {
    console.error('[store] saveConversations error:', err.message);
    return { success: false, error: err.message };
  }
});

// 동기 저장 — beforeunload에서 호출 (앱 종료 시 스트리밍 중 데이터 보존)
ipcMain.on('store:saveConversationsSync', (event, data) => {
  try {
    const filePath = getConversationsPath();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 0), 'utf8');
    event.returnValue = { success: true };
  } catch (err) {
    console.error('[store] saveConversationsSync error:', err.message);
    event.returnValue = { success: false, error: err.message };
  }
});

// --- Claude 설정 파일 읽기/쓰기 ---
function getSettingsPaths() {
  const homedir = os.homedir();
  return {
    global: path.join(homedir, '.claude', 'settings.json'),
    projectLocal: path.join(workingDirectory, '.claude', 'settings.local.json'),
  };
}

ipcMain.handle('settings:load', () => {
  try {
    const paths = getSettingsPaths();
    const result = {};
    for (const [key, filePath] of Object.entries(paths)) {
      try {
        if (fs.existsSync(filePath)) {
          result[key] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } else {
          result[key] = {};
        }
      } catch {
        result[key] = {};
      }
    }
    return { success: true, data: result, paths };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('settings:save', (event, { scope, data }) => {
  try {
    const paths = getSettingsPaths();
    const filePath = paths[scope];
    if (!filePath) return { success: false, error: `Unknown scope: ${scope}` };
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  app.quit();
});
