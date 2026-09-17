import path from 'path';

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

export async function extractTaskArchives() {
  const error = new Error('Archive extraction is unavailable until a staged, owned, no-clobber extraction pipeline is implemented.');
  error.code = 'EXTRACTION_UNAVAILABLE';
  throw error;
}
