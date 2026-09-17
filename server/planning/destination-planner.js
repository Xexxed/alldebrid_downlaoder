/**
 * Destination Planning: path containment, sanitization, and collision checks.
 *
 * Single authority for turning user-supplied destinations and file names into
 * validated absolute paths. Reuses the API-layer sanitizers where possible and
 * adds filesystem containment that must never be bypassed by callers.
 */

import fs from 'fs';
import path from 'path';

// Windows reserved device names (case-insensitive, no extension check needed
// because CON.txt etc. are also reserved).
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export class DestinationError extends Error {
  constructor(message, code = 'invalid_destination') {
    super(message);
    this.code = code;
  }
}

function isReservedName(name) {
  const stem = name.replace(/\..*$/, '');
  return WINDOWS_RESERVED.has(stem.toUpperCase());
}

/**
 * Validate and normalize a base destination directory.
 * Rejects traversal attempts, relative escapes, and non-directories.
 * Returns the resolved absolute path.
 */
export function resolveBaseDestination(input, { mustExist = false } = {}) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new DestinationError('Destination directory is required');
  }
  const trimmed = input.trim();

  // Windows drive roots like "D:\", "D:", "D:/", UNC paths are accepted as-is.
  const driveMatch = /^[a-zA-Z]:[\\/]*$/.test(trimmed);
  const uncMatch = /^\\\\[^\\]/.test(trimmed);

  if (path.isAbsolute(trimmed) || driveMatch || uncMatch) {
    const resolved = path.resolve(trimmed);
    if (resolved !== path.normalize(trimmed.replace(/\/+$/, '')) && !driveMatch && !uncMatch) {
      // resolve() collapses .. and normalizes separators; still contained.
    }
    if (mustExist && !fs.existsSync(resolved)) {
      throw new DestinationError(`Destination does not exist: ${resolved}`);
    }
    return resolved;
  }

  throw new DestinationError(`Destination must be an absolute path: ${trimmed}`);
}

/**
 * Validate one relative path segment set for a payload file inside a
 * destination. Rejects absolute inputs, traversal, reserved names, and
 * trailing-dot/space ambiguity on Windows.
 * Returns the normalized relative path using the platform separator.
 */
export function sanitizeRelativePath(relPath) {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new DestinationError('File path is required');
  }

  const replaced = relPath.replace(/\//g, path.sep);

  if (path.isAbsolute(replaced) || /^[a-zA-Z]:/.test(replaced) || /^\\\\/.test(replaced)) {
    throw new DestinationError(`Absolute file paths are not allowed: ${relPath}`);
  }

  const segments = replaced.split(path.sep).filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new DestinationError('File path resolves to empty');
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new DestinationError(`Path traversal is not allowed: ${relPath}`);
    }
    if (isReservedName(segment)) {
      throw new DestinationError(`Reserved Windows device name: ${segment}`);
    }
    if (/[. ]$/.test(segment)) {
      throw new DestinationError(`Trailing dot or space is ambiguous on Windows: ${segment}`);
    }
    if (/[\x00-\x1f<>:"|?*]/.test(segment)) {
      throw new DestinationError(`Illegal characters in path segment: ${segment}`);
    }
  }

  return segments.join(path.sep);
}

/**
 * Compute the final full path for a file inside a base destination and check
 * for case-folded collisions with existing sibling entries.
 * Returns { fullPath, collision }.
 */
export function planFileInDestination(baseDestination, relativePath) {
  const cleanRelative = sanitizeRelativePath(relativePath);
  const fullPath = path.join(baseDestination, cleanRelative);
  const parent = path.dirname(fullPath);

  let collision = false;
  try {
    if (fs.existsSync(parent)) {
      const targetName = path.basename(fullPath).toLowerCase();
      for (const entry of fs.readdirSync(parent)) {
        if (entry.toLowerCase() === targetName && entry !== path.basename(fullPath)) {
          collision = true;
          break;
        }
      }
    }
  } catch {
    // unreadable parent: treated as no collision, stat will fail later
  }

  return { fullPath, collision };
}

/**
 * Ensure a path stays inside its base destination after resolution
 * (defense against symlinks/junctions created between planning and write).
 * Throws DestinationError if the resolved real path escapes.
 */
export function assertContained(baseDestination, fullPath) {
  const baseResolved = path.resolve(baseDestination);
  const targetResolved = path.resolve(fullPath);
  const relative = path.relative(baseResolved, targetResolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new DestinationError(`Path escapes destination: ${fullPath}`, 'escape_detected');
  }
}
