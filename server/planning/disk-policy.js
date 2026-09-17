/**
 * Disk Policy: free-space accounting with per-volume reservations.
 *
 * Aggregates outstanding reservation bytes by volume so simultaneous tasks
 * on the same volume are counted once, and unrelated volumes are never
 * blocked by another volume's pressure. Unknown capacity is reported as
 * unknown, never as guaranteed-safe.
 */

import fs from 'fs';

export class DiskPolicy {
  constructor({ minFreeBytes = 0, statVolume = defaultStatVolume } = {}) {
    this.minFreeBytes = minFreeBytes;
    this.statVolume = statVolume;
    // volumeKey -> Map(reservationId -> bytes)
    this.reservations = new Map();
  }

  setMinFreeBytes(bytes) {
    this.minFreeBytes = Math.max(0, Number(bytes) || 0);
  }

  volumeKeyFor(dirPath) {
    return resolveVolumeKey(dirPath);
  }

  /**
   * Reserve bytes for a pending operation on a volume.
   * Returns { ok, freeBytes, shortageBytes } — false when the reservation
   * would push the volume below the minimum floor.
   */
  reserve(dirPath, reservationId, bytes) {
    const key = this.volumeKeyFor(dirPath);
    if (!key) {
      // Unknown volume: visible-unknown, not guaranteed safe.
      return { ok: true, freeBytes: null, unknownVolume: true };
    }

    const freeBytes = this.statVolume(dirPath);
    if (freeBytes === null) {
      return { ok: true, freeBytes: null, unknownCapacity: true };
    }

    const outstanding = this.outstandingFor(key);
    const projectedFree = freeBytes - outstanding - bytes;
    if (bytes > 0 && projectedFree < this.minFreeBytes) {
      return { ok: false, freeBytes, shortageBytes: this.minFreeBytes - projectedFree };
    }

    if (!this.reservations.has(key)) this.reservations.set(key, new Map());
    this.reservations.get(key).set(reservationId, bytes);
    return { ok: true, freeBytes };
  }

  release(dirPath, reservationId) {
    const key = this.volumeKeyFor(dirPath);
    const volumeReservations = this.reservations.get(key);
    if (volumeReservations) {
      volumeReservations.delete(reservationId);
      if (volumeReservations.size === 0) this.reservations.delete(key);
    }
  }

  outstandingFor(volumeKey) {
    const volumeReservations = this.reservations.get(volumeKey);
    if (!volumeReservations) return 0;
    let total = 0;
    for (const bytes of volumeReservations.values()) total += bytes;
    return total;
  }

  /**
   * Evaluate whether dirPath can accept `bytes` right now, accounting for
   * existing reservations on that volume (excluding the caller's own).
   */
  check(dirPath, bytes, { excludeReservationId = null } = {}) {
    const key = this.volumeKeyFor(dirPath);
    if (!key) return { ok: true, unknownVolume: true };
    const freeBytes = this.statVolume(dirPath);
    if (freeBytes === null) return { ok: true, unknownCapacity: true };

    let outstanding = 0;
    const volumeReservations = this.reservations.get(key);
    if (volumeReservations) {
      for (const [id, bytes] of volumeReservations.entries()) {
        if (id !== excludeReservationId) outstanding += bytes;
      }
    }

    const projectedFree = freeBytes - outstanding - bytes;
    if (bytes > 0 && projectedFree < this.minFreeBytes) {
      return { ok: false, freeBytes, shortageBytes: this.minFreeBytes - projectedFree };
    }
    return { ok: true, freeBytes };
  }
}

function defaultStatVolume(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return null;
    const stats = fs.statfsSync(dirPath);
    return stats.bsize * stats.bavail;
  } catch {
    return null;
  }
}

function resolveVolumeKey(dirPath) {
  // Windows: drive letter prefix. POSIX: single root volume (mount points
  // beyond / are not distinguished in the initial release).
  const winMatch = /^([a-zA-Z]:)/.exec(dirPath);
  if (winMatch) return winMatch[1].toUpperCase();
  if (dirPath.startsWith('\\\\')) {
    return dirPath.split(/[\\/]/).slice(0, 4).join('\\').toUpperCase();
  }
  if (dirPath.startsWith('/')) return '/';
  return null;
}
