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
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(options.body)) {
          (Array.isArray(v) ? v : [v]).forEach((val) => val != null && params.append(Array.isArray(v) ? `${k}[]` : k, val));
        }
        fetchOptions.body = params.toString();
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
 * Normalizes AllDebrid API magnet response data whether returned as an Array, single Object, or keyed Object
 * @param {Object} res - Response from getMagnetStatus or getMagnetFiles
 * @param {number|string} [magnetId] - Optional specific magnet ID to look for
 * @returns {Object|null}
 */
export function normalizeMagnetResponse(res, magnetId = null) {
  if (!res || !res.magnets) return null;
  const { magnets } = res;

  if (Array.isArray(magnets)) {
    if (magnetId != null) {
      const match = magnets.find((m) => m && (m.id === Number(magnetId) || String(m.id) === String(magnetId)));
      return match || magnets[0] || null;
    }
    return magnets[0] || null;
  }

  if (typeof magnets === 'object') {
    if (magnetId != null && magnets[magnetId]) {
      return magnets[magnetId];
    }
    if (magnets.id !== undefined || magnets.files !== undefined || magnets.filename !== undefined) {
      return magnets;
    }
    const values = Object.values(magnets);
    if (values.length > 0) {
      if (magnetId != null) {
        const match = values.find((m) => m && (m.id === Number(magnetId) || String(m.id) === String(magnetId)));
        return match || values[0] || null;
      }
      return values[0] || null;
    }
  }

  return null;
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
 * @param {boolean} isRoot - Whether this is the root call
 * @returns {Array<{ name: string, relativePath: string, size: number, link: string }>}
 */
export function flattenFileTree(entries, currentPath = '', isRoot = true) {
  if (!Array.isArray(entries)) return [];

  // If at the very root level and there is exactly 1 top-level folder wrapper,
  // unwrap it so relative paths are relative to the torrent root folder.
  if (isRoot && entries.length === 1 && Array.isArray(entries[0].e)) {
    return flattenFileTree(entries[0].e, '', false);
  }

  const results = [];

  for (const item of entries) {
    if (!item) continue;
    const name = sanitizePathSegment(item.n || 'unnamed');

    // If 'e' (entries) exists, it is a subfolder
    if (Array.isArray(item.e)) {
      const subPath = currentPath ? `${currentPath}/${name}` : name;
      const nested = flattenFileTree(item.e, subPath, false);
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
 * Converts human readable size string (e.g. "995 MB", "1.2 GB") to bytes
 */
export function parseHumanBytes(sizeStr) {
  if (!sizeStr || typeof sizeStr !== 'string') return 0;
  const match = sizeStr.trim().match(/^([\d.,]+)\s*([a-zA-Z]+)?$/);
  if (!match) return 0;
  const num = parseFloat(match[1].replace(/,/g, ''));
  if (isNaN(num)) return 0;
  const unit = (match[2] || 'B').toUpperCase();
  const k = 1024;
  if (unit.startsWith('K')) return Math.round(num * k);
  if (unit.startsWith('M')) return Math.round(num * k * k);
  if (unit.startsWith('G')) return Math.round(num * k * k * k);
  if (unit.startsWith('T')) return Math.round(num * k * k * k * k);
  return Math.round(num);
}

/**
 * Scrapes a Rapidgator folder URL, fetching all pages and extracting all contained file links
 * @param {string} folderUrl
 * @returns {Promise<{ folderName: string, files: Array<{ name: string, relativePath: string, link: string, size: number, sizeStr: string }>, totalSize: number }>}
 */
export async function fetchRapidgatorFolder(folderUrl) {
  const cleanUrl = folderUrl.split('#')[0];
  const urlObj = new URL(cleanUrl);
  const baseDomain = urlObj.origin;

  let currentUrl = cleanUrl;
  const visitedUrls = new Set();
  const fileMap = new Map(); // link -> { name, relativePath, link, size, sizeStr }
  let resolvedFolderName = '';
  let maxPages = 30; // Protect against infinite loops

  while (currentUrl && maxPages-- > 0 && !visitedUrls.has(currentUrl)) {
    visitedUrls.add(currentUrl);

    const res = await fetch(currentUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': folderUrl,
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch Rapidgator folder (HTTP ${res.status}): ${res.statusText}`);
    }

    const html = await res.text();

    // Extract folder name if not yet resolved
    if (!resolvedFolderName) {
      const headerMatch = html.match(/<div id="table_header"[^>]*>([\s\S]*?)<br/i);
      const downloadMatch = html.match(/Downloading:\s*<\/strong>\s*([^<]+)/i);
      const titleMatch = html.match(/<title>Download file\s*([^<]+)<\/title>/i);

      if (headerMatch && headerMatch[1].trim()) {
        resolvedFolderName = sanitizePathSegment(headerMatch[1].trim());
      } else if (downloadMatch && downloadMatch[1].trim()) {
        resolvedFolderName = sanitizePathSegment(downloadMatch[1].trim());
      } else if (titleMatch && titleMatch[1].trim()) {
        resolvedFolderName = sanitizePathSegment(titleMatch[1].trim());
      } else {
        // Fallback to URL path segment
        const segments = urlObj.pathname.split('/').filter(Boolean);
        const lastSeg = segments[segments.length - 1] || 'Rapidgator_Folder';
        resolvedFolderName = sanitizePathSegment(lastSeg.replace(/\.html$/i, ''));
      }
    }

    // Extract file rows from table
    // Row pattern: <td><a href="(/file/[^"]+)"><img[^>]*>\s*([^<]+)</a></td>\s*<td[^>]*>([^<]+)</td>
    const rowRegex = /<tr[^>]*>[\s\S]*?<a\s+href=["'](\/file\/[a-zA-Z0-9_-]+\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<td[^>]*class=["'][^"']*td-for-select[^"']*["'][^>]*>|<td[^>]*>)\s*([\d.,]+\s*[a-zA-Z]+)\s*<\/td>[\s\S]*?<\/tr>/gi;
    let rowMatch;
    let foundInPage = 0;

    while ((rowMatch = rowRegex.exec(html)) !== null) {
      foundInPage++;
      const rawHref = rowMatch[1];
      const fullLink = rawHref.startsWith('http') ? rawHref : `${baseDomain}${rawHref}`;
      
      // Clean HTML tags from name
      const rawName = rowMatch[2].replace(/<[^>]+>/g, '').trim();
      const filename = sanitizePathSegment(rawName) || path.basename(rawHref).replace(/\.html$/i, '');
      const sizeStr = rowMatch[3].trim();
      const sizeBytes = parseHumanBytes(sizeStr);

      if (!fileMap.has(fullLink)) {
        fileMap.set(fullLink, {
          name: filename,
          relativePath: filename,
          link: fullLink,
          size: sizeBytes,
          sizeStr,
        });
      }
    }

    // Fallback parser if regex didn't match table format
    if (foundInPage === 0) {
      const linkRegex = /href=["'](\/file\/[a-zA-Z0-9_-]+\/[^"']+)["']/gi;
      let m;
      while ((m = linkRegex.exec(html)) !== null) {
        const rawHref = m[1];
        const fullLink = rawHref.startsWith('http') ? rawHref : `${baseDomain}${rawHref}`;
        const filename = sanitizePathSegment(path.basename(rawHref).replace(/\.html$/i, ''));
        if (!fileMap.has(fullLink)) {
          fileMap.set(fullLink, {
            name: filename,
            relativePath: filename,
            link: fullLink,
            size: 0,
            sizeStr: 'Unknown',
          });
        }
      }
    }

    // Check for next page in pager
    // Example: <li class="page"><a href="/folder/1234567/sample_folder.html?page=2">2</a></li>
    // Example: <li class="next"><a href="...">...</a></li>
    const nextPageMatch = html.match(/<li class=["'][^"']*next[^"']*["']>\s*<a\s+href=["']([^"']+)["']/i) ||
                          html.match(/<li class=["']page["']>\s*<a\s+href=["']([^"']+)["'][^>]*>(?:\d+)<\/a>/i);

    if (nextPageMatch) {
      const nextHref = nextPageMatch[1];
      const nextFullUrl = nextHref.startsWith('http') ? nextHref : `${baseDomain}${nextHref}`;
      if (!visitedUrls.has(nextFullUrl)) {
        currentUrl = nextFullUrl;
        continue;
      }
    }

    // No next page found
    currentUrl = null;
  }

  const files = Array.from(fileMap.values());
  const totalSize = files.reduce((acc, f) => acc + (f.size || 0), 0);

  return {
    folderName: resolvedFolderName || 'Rapidgator_Folder',
    files,
    totalSize,
  };
}

/**
 * Parses user input for URLs, magnet links, or magnet IDs
 * Handles:
 * - https://alldebrid.com/getMagnet/685554127 (or getMagnet/685554127)
 * - magnet:?xt=urn:btih:...
 * - Direct magnet ID (e.g. 685554127)
 * - Rapidgator / hoster folder links (e.g. https://rapidgator.net/folder/...)
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

    // 5. Check for Rapidgator Folder URLs (e.g. rapidgator.net/folder/... or rg.to/folder/...)
    if (/https?:\/\/(?:www\.)?(?:rapidgator\.net|rg\.to)\/folder\//i.test(line)) {
      parsedItems.push({
        type: 'folderLink',
        host: 'rapidgator',
        url: line,
        original: line,
      });
      continue;
    }

    // 6. Check for standard HTTP/HTTPS links
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

