/**
 * AllDebrid API Client
 * Official API v4 / v4.1 implementation
 * Docs: https://docs.alldebrid.com/
 */

const API_BASE = 'https://api.alldebrid.com';
const AGENT = 'alldebrid-downloader';

export class AllDebridClient {
  constructor(apiKey = process.env.ALLDEBRID_API_KEY || '') {
    this.apiKey = apiKey;
  }

  setApiKey(key) {
    this.apiKey = key;
  }

  async _request(endpoint, options = {}) {
    if (!this.apiKey) {
      throw new Error('AllDebrid API Key is not configured. Please set it in .env or Settings.');
    }

    const url = new URL(`${API_BASE}${endpoint}`);
    url.searchParams.set('agent', AGENT);

    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      ...options.headers,
    };

    const fetchOptions = {
      method: options.method || 'GET',
      headers,
    };

    if (options.body) {
      if (options.isFormData) {
        fetchOptions.body = options.body;
      } else if (typeof options.body === 'object') {
        const formData = new URLSearchParams();
        for (const [key, value] of Object.entries(options.body)) {
          if (Array.isArray(value)) {
            value.forEach((v) => formData.append(`${key}[]`, v));
          } else if (value !== undefined && value !== null) {
            formData.append(key, value);
          }
        }
        fetchOptions.body = formData.toString();
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      } else {
        fetchOptions.body = options.body;
      }
    }

    const res = await fetch(url.toString(), fetchOptions);
    const json = await res.json().catch(() => null);

    if (!json) {
      throw new Error(`Invalid JSON response from AllDebrid API (HTTP ${res.status})`);
    }

    if (json.status !== 'success') {
      const err = json.error || {};
      const message = err.message || err.code || 'Unknown AllDebrid API error';
      const errorObj = new Error(message);
      errorObj.code = err.code;
      throw errorObj;
    }

    return json.data;
  }

  /**
   * Get user account information & premium status
   */
  async getUserInfo() {
    return this._request('/v4/user');
  }

  /**
   * Upload magnet URIs or hashes
   * @param {string|string[]} magnets
   */
  async uploadMagnet(magnets) {
    const list = Array.isArray(magnets) ? magnets : [magnets];
    return this._request('/v4/magnet/upload', {
      method: 'POST',
      body: { magnets: list },
    });
  }

  /**
   * Upload .torrent file
   * @param {Buffer} fileBuffer
   * @param {string} fileName
   */
  async uploadTorrentFile(fileBuffer, fileName = 'file.torrent') {
    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: 'application/x-bittorrent' });
    formData.append('files[]', blob, fileName);

    return this._request('/v4/magnet/upload/file', {
      method: 'POST',
      isFormData: true,
      body: formData,
    });
  }

  /**
   * Get status of user magnets
   * @param {number|string} [id] - Optional magnet ID
   * @param {string} [status] - Optional filter ('active', 'ready', 'expired', 'error')
   */
  async getMagnetStatus(id = null, status = null) {
    const body = {};
    if (id) body.id = id;
    if (status) body.status = status;

    return this._request('/v4.1/magnet/status', {
      method: 'POST',
      body,
    });
  }

  /**
   * Get recursive files and links tree for magnet(s)
   * @param {number|number[]} ids
   */
  async getMagnetFiles(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    return this._request('/v4/magnet/files', {
      method: 'POST',
      body: { id: list },
    });
  }

  /**
   * Unlock a link (e.g. https://alldebrid.com/f/xxxx or hoster link) to get direct CDN download URL
   * @param {string} link
   * @param {string} [password]
   */
  async unlockLink(link, password = '') {
    const body = { link };
    if (password) body.password = password;

    return this._request('/v4/link/unlock', {
      method: 'POST',
      body,
    });
  }

  /**
   * Delete a magnet from AllDebrid cloud
   * @param {number|string} id
   */
  async deleteMagnet(id) {
    return this._request('/v4/magnet/delete', {
      method: 'POST',
      body: { id },
    });
  }

  /**
   * Restart an errored magnet
   * @param {number|string} id
   */
  async restartMagnet(id) {
    return this._request('/v4/magnet/restart', {
      method: 'POST',
      body: { id },
    });
  }
}

/**
 * Sanitizes folder and file names across Windows, Linux, and macOS
 */
export function sanitizePathSegment(segment) {
  if (!segment) return '';
  return segment
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+$/, '_');
}

/**
 * Recursively parses the AllDebrid files tree structure into a flat list of files with relative paths
 * @param {Array} entries - The tree returned by /v4/magnet/files
 * @param {string} currentPath - The parent path accumulated so far
 * @returns {Array<{ name: string, relativePath: string, size: number, link: string }>}
 */
export function flattenFileTree(entries, currentPath = '') {
  if (!Array.isArray(entries)) return [];

  const results = [];

  for (const item of entries) {
    if (!item) continue;
    const name = sanitizePathSegment(item.n || 'unnamed');

    // If 'e' (entries) exists, it is a subfolder
    if (Array.isArray(item.e)) {
      const subPath = currentPath ? `${currentPath}/${name}` : name;
      const nested = flattenFileTree(item.e, subPath);
      results.push(...nested);
    } else if (item.l) {
      // It's a file
      const relativePath = currentPath ? `${currentPath}/${name}` : name;
      results.push({
        name,
        relativePath,
        size: Number(item.s) || 0,
        link: item.l,
      });
    }
  }

  return results;
}

/**
 * Parses user input for URLs, magnet links, or magnet IDs
 * Handles:
 * - https://alldebrid.com/getMagnet/685554127 (or getMagnet/685554127)
 * - magnet:?xt=urn:btih:...
 * - Direct magnet ID (e.g. 685554127)
 * - Direct hoster link (e.g. https://alldebrid.com/f/... or other hoster)
 */
export function parseDownloadInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return [];

  const lines = rawInput
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const parsedItems = [];

  for (const line of lines) {
    // 1. Check for getMagnet URL (e.g. https://alldebrid.com/getMagnet/685554127 or http://... or just getMagnet/123)
    const getMagnetMatch = line.match(/(?:alldebrid\.com\/getMagnet\/|getMagnet\/)(\d+)/i);
    if (getMagnetMatch) {
      parsedItems.push({
        type: 'getMagnet',
        id: parseInt(getMagnetMatch[1], 10),
        original: line,
      });
      continue;
    }

    // 2. Check for Magnet URI
    if (line.toLowerCase().startsWith('magnet:?')) {
      parsedItems.push({
        type: 'magnet',
        uri: line,
        original: line,
      });
      continue;
    }

    // 3. Check for 40-char infohash
    if (/^[0-9a-fA-F]{40}$/.test(line)) {
      parsedItems.push({
        type: 'magnet',
        uri: `magnet:?xt=urn:btih:${line}`,
        original: line,
      });
      continue;
    }

    // 4. Check for standalone numeric ID
    if (/^\d{5,12}$/.test(line)) {
      parsedItems.push({
        type: 'magnetId',
        id: parseInt(line, 10),
        original: line,
      });
      continue;
    }

    // 5. Check for standard HTTP/HTTPS links
    if (/^https?:\/\//i.test(line)) {
      parsedItems.push({
        type: 'directLink',
        url: line,
        original: line,
      });
      continue;
    }

    // Fallback unknown
    parsedItems.push({
      type: 'unknown',
      original: line,
    });
  }

  return parsedItems;
}
