/**
 * Archive Extractor Engine
 * Automatic Multi-Part RAR/ZIP/7z detection, extraction, and part cleanup
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

// Cache detected extractor executable path
let cachedExtractor = null;

/**
 * Detect available extraction tool on the host system
 */
export function detectExtractor() {
  if (cachedExtractor) return cachedExtractor;

  const isWin = process.platform === 'win32';

  if (isWin) {
    const candidatePaths = [
      'C:\\Program Files\\7-Zip\\7z.exe',
      'C:\\Program Files (x86)\\7-Zip\\7z.exe',
      'C:\\Program Files\\WinRAR\\UnRAR.exe',
      'C:\\Program Files\\WinRAR\\WinRAR.exe',
      'C:\\WINDOWS\\system32\\tar.exe',
    ];

    for (const p of candidatePaths) {
      try {
        if (fs.existsSync(p)) {
          const type = p.toLowerCase().includes('7z') ? '7z' : p.toLowerCase().includes('unrar') ? 'unrar' : p.toLowerCase().includes('winrar') ? 'winrar' : 'tar';
          cachedExtractor = { path: p, type };
          return cachedExtractor;
        }
      } catch {}
    }
  }

  // Fallback to command names in PATH
  cachedExtractor = { path: isWin ? 'tar.exe' : 'tar', type: 'tar' };
  return cachedExtractor;
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
export function detectArchiveGroups(filePathsOrObjects) {
  const fileList = filePathsOrObjects.map((item) => {
    if (typeof item === 'string') {
      return { name: path.basename(item), fullPath: path.resolve(item) };
    }
    return {
      name: item.name || path.basename(item.fullLocalPath || item.relativePath || ''),
      fullPath: item.fullLocalPath || path.resolve(item.relativePath || item.name),
    };
  });

  const archiveGroups = new Map(); // groupKey -> { type, baseName, entryFile, partFiles: [] }

  for (const file of fileList) {
    const name = file.name;
    const lower = name.toLowerCase();

    // 1. Multi-part RAR: name.part1.rar or name.part01.rar
    const partRarMatch = lower.match(/^([\s\S]+?)\.part(\d+)\.rar$/i);
    if (partRarMatch) {
      const baseKey = partRarMatch[1].toLowerCase();
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
      const baseKey = oldRarMatch[1].toLowerCase();
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
      const baseKey = `${splitMatch[1]}.${splitMatch[2]}`.toLowerCase();
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
      const baseKey = lower;
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
 * Extracts a single archive group to destination directory
 */
export async function extractArchive(entryFilePath, targetDir, options = {}) {
  const extractor = detectExtractor();
  if (!extractor) {
    throw new Error('No supported archive extractor (7-Zip, WinRAR, or tar) found on this machine');
  }

  await fs.promises.mkdir(targetDir, { recursive: true });

  return new Promise((resolve, reject) => {
    let args = [];
    const entryNorm = path.resolve(entryFilePath);
    const targetNorm = path.resolve(targetDir);

    if (extractor.type === '7z') {
      // 7-Zip: x = extract with full paths, -y = assume yes, -o<dir> = output directory, -aoa = overwrite all
      args = ['x', '-y', '-aoa', `-o${targetNorm}`, entryNorm];
    } else if (extractor.type === 'unrar') {
      // UnRAR: x = extract with full paths, -y = assume yes, -o+ = overwrite all
      args = ['x', '-y', '-o+', entryNorm, `${targetNorm}\\`];
    } else if (extractor.type === 'winrar') {
      // WinRAR GUI in silent mode: x -ibck (in background), -y, -o+
      args = ['x', '-ibck', '-y', '-o+', entryNorm, `${targetNorm}\\`];
    } else if (extractor.type === 'tar') {
      // tar.exe
      args = ['-xf', entryNorm, '-C', targetNorm];
    }

    const proc = spawn(extractor.path, args, {
      windowsHide: true,
    });

    let output = '';
    let errorOutput = '';

    proc.stdout?.on('data', (d) => {
      output += d.toString();
    });

    proc.stderr?.on('data', (d) => {
      errorOutput += d.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Extraction process failed to start: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, output });
      } else {
        reject(new Error(`Extraction failed with exit code ${code}: ${errorOutput || output || 'Unknown extractor error'}`));
      }
    });
  });
}

/**
 * Extracts all archive groups for a task, and deletes part files if requested
 */
export async function extractTaskArchives(task, deleteParts = false) {
  const targetDir = task.outputDir;
  if (!fs.existsSync(targetDir)) {
    throw new Error(`Target directory does not exist: ${targetDir}`);
  }

  // Find files from task or scan targetDir if files list is empty
  let fileList = [];
  if (task.files && task.files.length > 0) {
    fileList = task.files.map((f) => ({
      name: f.name,
      fullPath: f.fullLocalPath,
    }));
  } else {
    try {
      const dirEntries = fs.readdirSync(targetDir, { withFileTypes: true });
      fileList = dirEntries.filter((e) => e.isFile()).map((e) => ({
        name: e.name,
        fullPath: path.join(targetDir, e.name),
      }));
    } catch {}
  }

  const groups = detectArchiveGroups(fileList);
  if (groups.length === 0) {
    return { extractedCount: 0, deletedFiles: [], message: 'No archive files detected' };
  }

  let extractedCount = 0;
  const deletedFiles = [];

  for (const group of groups) {
    if (!group.entryFile || !fs.existsSync(group.entryFile)) {
      continue;
    }

    // Run extraction
    await extractArchive(group.entryFile, targetDir);
    extractedCount++;

    // If part cleanup is requested, delete all parts for this group
    if (deleteParts && group.partFiles && group.partFiles.length > 0) {
      for (const partPath of group.partFiles) {
        try {
          if (fs.existsSync(partPath)) {
            fs.unlinkSync(partPath);
            deletedFiles.push(partPath);
          }
        } catch (err) {
          console.error(`Failed to delete archive part ${partPath}:`, err);
        }
      }
    }
  }

  return {
    extractedCount,
    deletedFiles,
    message: `Extracted ${extractedCount} archive group(s)${deletedFiles.length > 0 ? `, cleaned up ${deletedFiles.length} part file(s)` : ''}`,
  };
}
