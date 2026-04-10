'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================
// parseFrontmatter (main.js에서 추출)
// ============================================================
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { meta: {}, body: content.trim() };
  const meta = {};
  match[1].split(/\r?\n/).forEach(line => {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1].trim()] = kv[2].trim();
  });
  return { meta, body: content.slice(match[0].length).trim() };
}

// ============================================================
// listCustomCommands 로직 (IPC 래퍼 제외한 순수 로직)
// ============================================================
function listCustomCommandsLogic(projectCwd, globalDir) {
  const projectDir = path.join(projectCwd, '.claude', 'commands');
  const commands = [];
  const seenNames = new Set();

  for (const dir of [projectDir, globalDir]) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        const cmdName = '/' + file.replace(/\.md$/i, '');
        if (seenNames.has(cmdName)) continue;
        seenNames.add(cmdName);
        const { meta, body } = parseFrontmatter(content);
        commands.push({
          command: cmdName,
          description: meta.description || '',
          usage: meta.usage || cmdName,
          body,
          source: dir === projectDir ? 'project' : 'global',
          fileName: file,
        });
      } catch { /* skip */ }
    }
  }
  return commands;
}

// ============================================================
// parseFrontmatter 테스트
// ============================================================
describe('parseFrontmatter', () => {
  test('frontmatter와 body를 올바르게 파싱한다', () => {
    const content = `---\ndescription: 테스트 커맨드\nusage: /test [arg]\n---\n\n본문 내용입니다.`;
    const { meta, body } = parseFrontmatter(content);
    assert.equal(meta.description, '테스트 커맨드');
    assert.equal(meta.usage, '/test [arg]');
    assert.equal(body, '본문 내용입니다.');
  });

  test('frontmatter 없으면 빈 meta, 전체를 body로 반환한다', () => {
    const content = `그냥 내용만 있는 파일`;
    const { meta, body } = parseFrontmatter(content);
    assert.deepEqual(meta, {});
    assert.equal(body, '그냥 내용만 있는 파일');
  });

  test('빈 문자열을 처리한다', () => {
    const { meta, body } = parseFrontmatter('');
    assert.deepEqual(meta, {});
    assert.equal(body, '');
  });

  test('CRLF 줄바꿈을 처리한다', () => {
    const content = `---\r\ndescription: CRLF 테스트\r\n---\r\n본문`;
    const { meta, body } = parseFrontmatter(content);
    assert.equal(meta.description, 'CRLF 테스트');
    assert.equal(body, '본문');
  });

  test('frontmatter만 있고 body가 없는 경우', () => {
    const content = `---\ndescription: 설명만\n---`;
    const { meta, body } = parseFrontmatter(content);
    assert.equal(meta.description, '설명만');
    assert.equal(body, '');
  });

  test('알 수 없는 키도 파싱한다', () => {
    const content = `---\ncustomKey: 값\n---\n내용`;
    const { meta } = parseFrontmatter(content);
    assert.equal(meta.customKey, '값');
  });
});

// ============================================================
// listCustomCommands 로직 테스트 (파일 시스템 사용)
// ============================================================
describe('listCustomCommands 로직', () => {
  let tmpDir;
  let projectCwd;
  let globalDir;

  // 각 테스트 전에 임시 디렉토리 생성
  const setup = () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-chat-test-'));
    projectCwd = path.join(tmpDir, 'project');
    globalDir = path.join(tmpDir, 'global', '.claude', 'commands');
    fs.mkdirSync(path.join(projectCwd, '.claude', 'commands'), { recursive: true });
    fs.mkdirSync(globalDir, { recursive: true });
  };

  const teardown = () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  test('프로젝트 커맨드 파일을 읽는다', () => {
    setup();
    try {
      const cmdFile = path.join(projectCwd, '.claude', 'commands', 'my-cmd.md');
      fs.writeFileSync(cmdFile, `---\ndescription: 내 커맨드\nusage: /my-cmd [arg]\n---\n\n프롬프트 내용`);
      const result = listCustomCommandsLogic(projectCwd, globalDir);
      assert.equal(result.length, 1);
      assert.equal(result[0].command, '/my-cmd');
      assert.equal(result[0].description, '내 커맨드');
      assert.equal(result[0].usage, '/my-cmd [arg]');
      assert.equal(result[0].body, '프롬프트 내용');
      assert.equal(result[0].source, 'project');
    } finally { teardown(); }
  });

  test('글로벌 커맨드 파일을 읽는다', () => {
    setup();
    try {
      const cmdFile = path.join(globalDir, 'global-cmd.md');
      fs.writeFileSync(cmdFile, `---\ndescription: 글로벌 커맨드\n---\n글로벌 프롬프트`);
      const result = listCustomCommandsLogic(projectCwd, globalDir);
      assert.equal(result.length, 1);
      assert.equal(result[0].command, '/global-cmd');
      assert.equal(result[0].source, 'global');
    } finally { teardown(); }
  });

  test('프로젝트 커맨드가 글로벌보다 우선한다 (동일 이름)', () => {
    setup();
    try {
      const projectCmd = path.join(projectCwd, '.claude', 'commands', 'shared.md');
      const globalCmd = path.join(globalDir, 'shared.md');
      fs.writeFileSync(projectCmd, `---\ndescription: 프로젝트\n---\n프로젝트 내용`);
      fs.writeFileSync(globalCmd, `---\ndescription: 글로벌\n---\n글로벌 내용`);
      const result = listCustomCommandsLogic(projectCwd, globalDir);
      assert.equal(result.length, 1);
      assert.equal(result[0].source, 'project');
      assert.equal(result[0].description, '프로젝트');
    } finally { teardown(); }
  });

  test('커맨드 디렉토리가 없어도 빈 배열을 반환한다', () => {
    setup();
    try {
      const emptyProject = path.join(tmpDir, 'empty-project');
      fs.mkdirSync(emptyProject, { recursive: true });
      const emptyGlobal = path.join(tmpDir, 'nonexistent-global');
      const result = listCustomCommandsLogic(emptyProject, emptyGlobal);
      assert.equal(result.length, 0);
    } finally { teardown(); }
  });

  test('.md가 아닌 파일은 무시한다', () => {
    setup();
    try {
      fs.writeFileSync(path.join(projectCwd, '.claude', 'commands', 'not-a-cmd.txt'), 'ignored');
      fs.writeFileSync(path.join(projectCwd, '.claude', 'commands', 'valid.md'), `---\ndescription: 유효\n---\n내용`);
      const result = listCustomCommandsLogic(projectCwd, globalDir);
      assert.equal(result.length, 1);
      assert.equal(result[0].command, '/valid');
    } finally { teardown(); }
  });

  test('frontmatter 없는 .md 파일도 읽는다 (description 빈 문자열)', () => {
    setup();
    try {
      fs.writeFileSync(path.join(projectCwd, '.claude', 'commands', 'no-meta.md'), '그냥 내용');
      const result = listCustomCommandsLogic(projectCwd, globalDir);
      assert.equal(result.length, 1);
      assert.equal(result[0].description, '');
      assert.equal(result[0].body, '그냥 내용');
    } finally { teardown(); }
  });

  test('usage가 없으면 커맨드명을 usage로 사용한다', () => {
    setup();
    try {
      fs.writeFileSync(path.join(projectCwd, '.claude', 'commands', 'no-usage.md'), `---\ndescription: 설명\n---\n내용`);
      const result = listCustomCommandsLogic(projectCwd, globalDir);
      assert.equal(result[0].usage, '/no-usage');
    } finally { teardown(); }
  });
});

// ============================================================
// CLI 커맨드 파싱 로직 테스트
// ============================================================
describe('CLI --help 출력 파싱', () => {
  // 실제 파싱 로직 (main.js의 discoverCliCommands에서 추출)
  function parseCliHelp(helpOutput) {
    const commands = [];
    const seen = new Set();
    const lines = helpOutput.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s{1,6}(\/[\w-]+)\s{2,}(.+)$/);
      if (!m) continue;
      const cmd = m[1].trim();
      if (seen.has(cmd)) continue;
      seen.add(cmd);
      commands.push({ command: cmd, description: m[2].trim(), usage: cmd });
    }
    return commands;
  }

  test('슬래시 커맨드 라인을 파싱한다', () => {
    const helpOutput = `
Usage: claude [options]

Commands:
  /help        Show help information
  /clear       Clear conversation history
  /model       Change the model

Options:
  --version    Show version
`;
    const result = parseCliHelp(helpOutput);
    assert.equal(result.length, 3);
    assert.equal(result[0].command, '/help');
    assert.equal(result[0].description, 'Show help information');
    assert.equal(result[1].command, '/clear');
    assert.equal(result[2].command, '/model');
  });

  test('중복 커맨드는 한 번만 추가한다', () => {
    const helpOutput = `  /help   First occurrence\n  /help   Second occurrence`;
    const result = parseCliHelp(helpOutput);
    assert.equal(result.length, 1);
    assert.equal(result[0].description, 'First occurrence');
  });

  test('슬래시로 시작하지 않는 라인은 무시한다', () => {
    const helpOutput = `  notacommand   this should be ignored\n  /valid   this is valid`;
    const result = parseCliHelp(helpOutput);
    assert.equal(result.length, 1);
    assert.equal(result[0].command, '/valid');
  });

  test('빈 출력이면 빈 배열을 반환한다', () => {
    assert.deepEqual(parseCliHelp(''), []);
  });
});
