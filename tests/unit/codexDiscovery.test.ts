import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { discoverCodexExecutable } from '../../src/main/codex/discovery';

const originalPath = process.env.PATH;
const temporaryDirectories: string[] = [];

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('descoberta do executável do Codex', () => {
  it('não consulta o PATH quando o caminho configurado é exclusivo', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-discovery-'));
    temporaryDirectories.push(directory);
    const executableName = process.platform === 'win32' ? 'codex-test.exe' : 'codex-test';
    const executablePath = join(directory, executableName);
    writeFileSync(executablePath, '');
    if (process.platform !== 'win32') chmodSync(executablePath, 0o755);
    process.env.PATH = [directory, originalPath].filter(Boolean).join(delimiter);

    const missingConfiguredPath = join(directory, 'ausente');
    expect(
      discoverCodexExecutable({
        configuredPath: missingConfiguredPath,
        configuredPathOnly: true,
        binaryName: 'codex-test',
      }),
    ).toBeNull();

    expect(
      discoverCodexExecutable({ configuredPath: missingConfiguredPath, binaryName: 'codex-test' })?.filePath,
    ).toBe(executablePath);
  });
});
