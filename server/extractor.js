/**
 * Staged archive extraction with no-clobber publishing.
 *
 * Security model:
 * - Extraction runs in a staging directory inside the task output dir and
 *   never writes in place: staged outputs are moved (no-clobber) into the
 *   output directory only after the extractor exits successfully.
 * - Only files with explicit task provenance (ownership === 'owned' AND
 *   verification === 'size_verified' AND status === 'completed') are eligible
 *   for extraction or cleanup. Pre-existing files are never deleted.
 * - Archive paths are validated against the task output directory before any
 *   child process runs; extractor failure never mutates published output.
 * - Multi-volume sets (part rar, split 7z/zip) require 7-Zip (SEVEN_ZIP env or
 *   7z on PATH); bsdtar/libarchive cannot reassemble them.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const STAGING_DIR_NAME = '.extraction-staging';

export class ExtractionError extends Error {
  constructor(message, code = 'EXTRACTION_FAILED') {
    super(message);
    this.code = code;
  }
}

/**
 * Checks if a filename is an archive or part file
 */
export function isArchiveFile(filename) {
  if (!filename || typeof filename !== 'string') return false;
  const lower = filename.toLowerCase();

  // Multi-part RAR
  if (/\.part\d+\.rar$/i.test(lower)) return true;
  if (/\.r\d{2}$/i.test(lower)) return true;

  // Multi-part 7z / ZIP
  if (/\.(?:7z|zip)\.\d{3}$/i.test(lower)) return true;
  if (/\.z\d{2}$/i.test(lower)) return true;

  // Single archives
  if (/\.(rar|zip|7z|tar|gz|tgz|bz2|xz|iso)$/i.test(lower)) return true;

  return false;
}

/**
 * Analyzes a list of files or directory contents to detect archive sets
 * Returns grouped archive objects with entry file and all constituent part files
 */
export function detectArchiveGroups(filePathsOrObjects, baseDir = '') {
  const fileList = filePathsOrObjects.map((item) => {
    if (typeof item === 'string') {
      const resolved = baseDir ? path.resolve(baseDir, item) : path.resolve(item);
      return { name: path.basename(item), fullPath: resolved };
    }
    const name = item.name || path.basename(item.fullPath || item.fullLocalPath || item.relativePath || '');
    let fullPath = item.fullPath || item.fullLocalPath;
    if (!fullPath && item.relativePath) {
      fullPath = baseDir ? path.resolve(baseDir, item.relativePath) : path.resolve(item.relativePath);
    }
    if (!fullPath && name) {
      fullPath = baseDir ? path.resolve(baseDir, name) : path.resolve(name);
    }
    return {
      name,
      fullPath,
    };
  });

  const archiveGroups = new Map(); // groupKey -> { type, baseName, entryFile, partFiles: [] }
  const fileDirKey = (file) => {
    const dir = path.dirname(file.fullPath || file.name || '');
    // Case-folded directory identity so same-named archives in different
    // folders form independent groups (and cleanup cannot cross folders).
    return dir.toLowerCase();
  };

  for (const file of fileList) {
    const name = file.name;
    const lower = name.toLowerCase();

    // 1. Multi-part RAR: name.part1.rar or name.part01.rar
    const partRarMatch = lower.match(/^([\s\S]+?)\.part(\d+)\.rar$/i);
    if (partRarMatch) {
      const baseKey = `${fileDirKey(file)}|${partRarMatch[1].toLowerCase()}`;
      const partNum = parseInt(partRarMatch[2], 10);

      if (!archiveGroups.has(`partrar_${baseKey}`)) {
        archiveGroups.set(`partrar_${baseKey}`, {
          type: 'multipart_rar',
          baseName: partRarMatch[1],
          entryFile: null,
          lowestPartNum: Infinity,
          partFiles: [],
        });
      }

      const group = archiveGroups.get(`partrar_${baseKey}`);
      group.partFiles.push(file.fullPath);
      if (partNum < group.lowestPartNum) {
        group.lowestPartNum = partNum;
        group.entryFile = file.fullPath;
      }
      continue;
    }

    // 2. Old-style multi-part RAR: name.rar, name.r00, name.r01
    const oldRarMatch = lower.match(/^([\s\S]+?)\.(rar|r\d{2})$/i);
    if (oldRarMatch && (oldRarMatch[2] === 'rar' || /r\d{2}/.test(oldRarMatch[2]))) {
      const baseKey = `${fileDirKey(file)}|${oldRarMatch[1].toLowerCase()}`;
      const isRar = oldRarMatch[2] === 'rar';

      if (!archiveGroups.has(`oldrar_${baseKey}`)) {
        archiveGroups.set(`oldrar_${baseKey}`, {
          type: 'multipart_rar_old',
          baseName: oldRarMatch[1],
          entryFile: null,
          partFiles: [],
        });
      }

      const group = archiveGroups.get(`oldrar_${baseKey}`);
      group.partFiles.push(file.fullPath);
      if (isRar || !group.entryFile) {
        group.entryFile = file.fullPath;
      }
      continue;
    }

    // 3. Multi-part 7z / ZIP (.7z.001, .zip.001)
    const splitMatch = lower.match(/^([\s\S]+?)\.(7z|zip)\.(\d{3})$/i);
    if (splitMatch) {
      const baseKey = `${fileDirKey(file)}|${splitMatch[1].toLowerCase()}.${splitMatch[2]}`;
      const partNum = parseInt(splitMatch[3], 10);

      if (!archiveGroups.has(`split_${baseKey}`)) {
        archiveGroups.set(`split_${baseKey}`, {
          type: 'split_archive',
          baseName: splitMatch[1],
          entryFile: null,
          lowestPartNum: Infinity,
          partFiles: [],
        });
      }

      const group = archiveGroups.get(`split_${baseKey}`);
      group.partFiles.push(file.fullPath);
      if (partNum < group.lowestPartNum) {
        group.lowestPartNum = partNum;
        group.entryFile = file.fullPath;
      }
      continue;
    }

    // 4. Standalone archive (.zip, .rar, .7z, .tar.gz, etc.)
    if (/\.(rar|zip|7z|tar|gz|tgz|bz2|xz|iso)$/i.test(lower)) {
      const baseKey = `${fileDirKey(file)}|${lower}`;
      if (!archiveGroups.has(`single_${baseKey}`)) {
        archiveGroups.set(`single_${baseKey}`, {
          type: 'single_archive',
          baseName: name,
          entryFile: file.fullPath,
          partFiles: [file.fullPath],
        });
      }
    }
  }

  return Array.from(archiveGroups.values());
}

/**
 * Resolve the extraction tool. Multi-volume groups require 7-Zip; bsdtar
 * (Windows tar.exe) handles single-volume zip/tar/7z/rar-v4 reading.
 */
export function resolveExtractorCommand(toolPath, platform = process.platform) {
  const base = path.basename(toolPath).toLowerCase().replace(/\.exe$/, '');
  if (base === 'tar' || base === 'bsdtar') return 'bsdtar';
  if (base === '7z' || base === '7za' || base === '7zz') return '7z';
  if (platform === 'win32' && base === 'tar') return 'bsdtar';
  return base;
}

function findTool(env = process.env) {
  if (env.SEVEN_ZIP) return { toolPath: env.SEVEN_ZIP, multiVolume: true };
  const pathDirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exeNames = process.platform === 'win32' ? ['7z.exe', '7za.exe'] : ['7z', '7za', '7zz'];
  for (const dir of pathDirs) {
    for (const name of exeNames) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return { toolPath: candidate, multiVolume: true };
      } catch {}
    }
  }
  return { toolPath: process.platform === 'win32' ? 'tar' : 'bsdtar', multiVolume: false };
}

function containedRelative(baseDir, targetPath) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative;
}

async function runExtractor(toolPath, args, timeoutMs, { spawnImpl = spawn, env = process.env } = {}) {
  const child = spawnImpl(toolPath, args, { windowsHide: true, env });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  child.stdout?.resume();
  let timer;
  const timedOut = new Error(`Extractor timed out after ${timeoutMs}ms`);
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut.timedOut = true;
      child.kill();
      resolve();
    }, timeoutMs);
  });
  timer.unref?.();
  try {
    const raced = await Promise.race([
      timeout,
      Promise.all([once(child, 'exit').catch(() => ['error', null])]).then(([[code, signal]]) => ({ code, signal })),
      once(child, 'error').then((error) => {
        throw new ExtractionError(`Failed to launch extractor "${toolPath}": ${error.message}`);
      }),
    ]);
    if (raced === undefined) {
      // Timeout fired: the child was killed; wait for it to actually exit so
      // the failure is fully contained before reporting.
      await once(child, 'exit').catch(() => ['error', null]);
      throw timedOut instanceof ExtractionError ? timedOut : new ExtractionError(timedOut.message);
    }
    const { code, signal } = raced;
    if (code !== 0 || signal) {
      const detail = stderr.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
      throw new ExtractionError(
        `Extractor "${path.basename(String(toolPath))}" failed (exit=${code ?? signal})${detail ? `: ${detail}` : ''}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify the destination's existing ancestors are real directories inside the
 * canonical output root (defense against symlink/junction redirection between
 * planning and publish, which lexical containment cannot see).
 */
function destinationAncestorSafe(outputDirReal, finalPath) {
  let current = path.dirname(finalPath);
  while (true) {
    let real;
    try {
      real = fs.realpathSync(current);
    } catch {
      // Parent does not exist yet; it will be created as a fresh directory.
      const parent = path.dirname(current);
      if (parent === current) return true;
      current = parent;
      continue;
    }
    const relative = path.relative(outputDirReal, real);
    return !(relative.startsWith('..') || path.isAbsolute(relative));
  }
}

/**
 * Move staged files into the output directory without ever overwriting an
 * existing file. Returns { published, staged }: staged counts every regular
 * file the extractor produced, published counts the ones moved into place.
 */
function publishStagedFiles(stagingDir, outputDir, outputDirReal) {
  const published = [];
  let staged = 0;
  const stack = [stagingDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let dirEntries;
    try {
      dirEntries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirEntries) {
      const stagedPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(stagedPath);
        continue;
      }
      // Symlinks and other non-regular staged entries are never published.
      if (!entry.isFile()) continue;
      staged++;
      const relative = containedRelative(stagingDir, stagedPath);
      if (!relative) continue; // refuse anything staging itself or escaping
      const finalPath = path.join(outputDir, relative);
      const contained = containedRelative(outputDir, finalPath);
      if (!contained) continue;
      // Ancestor check: an existing symlinked directory between outputDir
      // and the target must not redirect the publish outside the root.
      if (!destinationAncestorSafe(outputDirReal, finalPath)) {
        console.warn(`[Extractor] Refusing publish through non-directory ancestor: ${relative}`);
        continue;
      }
      if (fs.existsSync(finalPath)) continue; // no-clobber: keep existing file
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      fs.renameSync(stagedPath, finalPath);
      published.push(finalPath);
    }
  }
  return { published, staged };
}

/**
 * Verify cleanup authorization at deletion time: only owned, size-verified,
 * completed archive files inside the task output directory that belong to the
 * processed group are removable.
 */
function resolveCleanupTargets(task, outputDir, group) {
  const groupPaths = new Set((group.partFiles || []).map((p) => path.resolve(p)));
  const targets = [];
  for (const file of task.files || []) {
    if (!groupPaths.has(path.resolve(file.fullLocalPath || ''))) continue;
    if (!isArchiveFile(file.name || '')) continue;
    if (file.status !== 'completed' || file.ownership !== 'owned' || file.verification !== 'size_verified') continue;
    const resolved = path.resolve(file.fullLocalPath || '');
    if (!containedRelative(outputDir, resolved)) continue;
    try {
      if (!fs.statSync(resolved).isFile()) continue;
    } catch {
      continue;
    }
    targets.push({ file, resolved });
  }
  return targets;
}

function deleteVerifiedPartFiles(targets) {
  const deleted = [];
  for (const { file, resolved } of targets) {
    try {
      fs.rmSync(resolved, { force: true });
      deleted.push(file.fullLocalPath);
      file.status = 'deleted_after_extract';
    } catch (error) {
      console.error(`[Extractor] Failed to delete archive part ${file.fullLocalPath}:`, error.message);
    }
  }
  return deleted;
}

function listStagedRegularFiles(dir) {
  const results = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let dirEntries;
    try {
      dirEntries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirEntries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) results.push(fullPath);
    }
  }
  return results;
}

export async function extractTaskArchives(task, deleteParts = false, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!task || typeof task !== 'object' || typeof task.outputDir !== 'string' || task.outputDir.trim() === '') {
    throw new ExtractionError('Task with a valid outputDir is required for extraction', 'EXTRACTION_INVALID_TASK');
  }
  const outputDir = path.resolve(task.outputDir);

  // Provenance gate: only owned + size-verified completed files inside the
  // task output directory participate. Pre-existing or external files never do.
  const eligibleFiles = (task.files || []).filter((f) => {
    if (f.status !== 'completed' || f.ownership !== 'owned' || f.verification !== 'size_verified') return false;
    return containedRelative(outputDir, path.resolve(f.fullLocalPath || '')) !== null;
  });
  const eligibleEntries = eligibleFiles.map((f) => ({ name: f.name, fullPath: f.fullLocalPath }));
  const groups = detectArchiveGroups(eligibleEntries);
  if (groups.length === 0) {
    return { message: 'No archives to extract', extracted: [], deleted: [] };
  }

  const { toolPath, multiVolume } = findTool(options.env || process.env);
  // Multi-volume = a group with more than one member (e.g. .rar + .rNN, or
  // .7z.001 + .7z.002). A standalone .rar is single-volume and bsdtar reads it.
  const unsupported = groups.filter((group) => (group.partFiles?.length || 0) > 1 && !multiVolume);
  if (unsupported.length > 0) {
    throw new ExtractionError(
      `Multi-volume archive(s) require 7-Zip (set SEVEN_ZIP or install 7z): ` +
      unsupported.map((group) => group.baseName).join(', '),
      'EXTRACTION_TOOL_MISSING',
    );
  }

  fs.mkdirSync(outputDir, { recursive: true });
  let outputDirReal;
  try {
    outputDirReal = fs.realpathSync(outputDir);
  } catch {
    outputDirReal = outputDir;
  }
  const stagingDir = fs.mkdtempSync(path.join(outputDir, `${STAGING_DIR_NAME}-`));

  const is7z = resolveExtractorCommand(toolPath) === '7z';
  const published = [];
  let anyStaged = false;
  const deleted = [];
  try {
    for (const group of groups) {
      const args = is7z
        ? ['x', '-y', `-o${stagingDir}`, group.entryFile]
        : ['-xf', group.entryFile, '-C', stagingDir];
      await runExtractor(toolPath, args, timeoutMs, options);
      const { published: moved, staged } = publishStagedFiles(stagingDir, outputDir, outputDirReal);
      anyStaged = anyStaged || staged > 0;
      published.push(...moved);

      // Cleanup authorization is per group: only groups whose staged output
      // was fully published (every member moved, no collisions) may have
      // their archives removed.
      if (deleteParts && staged > 0 && moved.length === staged) {
        deleted.push(...deleteVerifiedPartFiles(resolveCleanupTargets(task, outputDir, group)));
      } else if (deleteParts && staged > 0) {
        console.warn(`[Extractor] Retaining archives of group "${group.baseName}": staged output collided with existing files.`);
      }
    }
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  if (!anyStaged) {
    // Nothing staged at all: extractor read the archive but produced no
    // members. Real payload loss, distinct from no-clobber skipping.
    throw new ExtractionError('Extractor produced no files', 'EXTRACTION_EMPTY');
  }

  return {
    message: `Extracted ${published.length} file(s)${deleted.length ? `, deleted ${deleted.length} archive part(s)` : ''}`,
    extracted: published,
    deleted,
  };
}
