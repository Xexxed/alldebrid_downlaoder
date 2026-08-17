/**
 * Multi-Provider Torrent & Release Search Engine with Live AllDebrid Instant Cache Inspection
 * Providers: ThePirateBay (APIBay), YTS (Movies), EZTV (TV Shows), Nyaa (Anime), Jackett/Prowlarr
 */

import { parseHumanBytes } from './alldebrid.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.coppersurfer.tk:6969/announce',
];

export function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i] || 'B'}`;
}

/**
 * Extracts 40-character hexadecimal infohash from a magnet URI
 */
export function extractHashFromMagnet(magnetUri) {
  if (!magnetUri || typeof magnetUri !== 'string') return null;
  const match = magnetUri.match(/urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  if (!match) return null;
  const raw = match[1];
  if (raw.length === 40) return raw.toLowerCase();
  return raw.toLowerCase();
}

/**
 * Builds standard magnet URI from hash, title, and tracker list
 */
export function buildMagnetUri(hash, title, extraTrackers = []) {
  if (!hash) return '';
  const cleanHash = hash.trim().toLowerCase();
  const trParams = [...DEFAULT_TRACKERS, ...extraTrackers]
    .map((tr) => `&tr=${encodeURIComponent(tr)}`)
    .join('');
  const dnParam = title ? `&dn=${encodeURIComponent(title)}` : '';
  return `magnet:?xt=urn:btih:${cleanHash}${dnParam}${trParams}`;
}

/**
 * Search ThePirateBay via APIBay
 */
export async function searchPirateBay(query) {
  if (!query || !query.trim()) return [];
  const url = `https://apibay.org/q.php?q=${encodeURIComponent(query.trim())}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(6000),
  });

  if (!res.ok) throw new Error(`PirateBay HTTP ${res.status}`);
  const items = await res.json();
  if (!Array.isArray(items)) return [];

  const categoryMap = {
    '101': 'Audio', '102': 'Audio', '103': 'Audio', '104': 'Audio',
    '201': 'Movies', '202': 'Movies', '203': 'Music Videos', '204': 'Movie Clips', '205': 'TV Shows', '206': 'Handheld', '207': 'HD Movies', '208': 'HD TV', '209': '3D',
    '301': 'Apps (Windows)', '302': 'Apps (Mac)', '303': 'Apps (UNIX)', '304': 'Apps (Handheld)', '305': 'Apps (iOS)', '306': 'Apps (Android)',
    '401': 'Games (PC)', '402': 'Games (Mac)', '403': 'Games (PSx)', '404': 'Games (XBOX)', '405': 'Games (Wii)', '406': 'Games (Handheld)',
  };

  return items
    .filter((item) => item.name && item.name !== 'No results returned' && item.info_hash && item.info_hash !== '0000000000000000000000000000000000000000')
    .map((item) => {
      const hash = item.info_hash.toLowerCase();
      const sizeBytes = Number(item.size) || 0;
      const catCode = String(item.category || '');
      let category = categoryMap[catCode] || 'General';
      if (catCode.startsWith('2')) category = 'Movies & TV';
      if (catCode.startsWith('3')) category = 'Apps & Software';
      if (catCode.startsWith('4')) category = 'Games';

      return {
        title: item.name,
        infoHash: hash,
        magnet: buildMagnetUri(hash, item.name),
        size: sizeBytes,
        sizeStr: formatBytes(sizeBytes),
        seeders: Number(item.seeders) || 0,
        leechers: Number(item.leechers) || 0,
        category,
        indexer: 'ThePirateBay',
        uploadedAt: item.added ? new Date(Number(item.added) * 1000).toISOString() : null,
      };
    });
}

/**
 * Search YTS Movies
 */
export async function searchYTS(query) {
  if (!query || !query.trim()) return [];
  const mirrors = ['https://yts.lt', 'https://yts.mx', 'https://yts.rs'];
  let data = null;

  for (const mirror of mirrors) {
    try {
      const url = `${mirror}/api/v2/list_movies.json?query_term=${encodeURIComponent(query.trim())}&limit=25`;
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const json = await res.json();
        if (json?.data?.movies) {
          data = json.data.movies;
          break;
        }
      }
    } catch {}
  }

  if (!data || !Array.isArray(data)) return [];

  const results = [];
  for (const movie of data) {
    if (!movie.torrents || !Array.isArray(movie.torrents)) continue;
    for (const t of movie.torrents) {
      if (!t.hash) continue;
      const hash = t.hash.toLowerCase();
      const title = `${movie.title_long || movie.title} [${t.quality || '1080p'}] [${(t.type || '').toUpperCase()}]`;
      results.push({
        title,
        infoHash: hash,
        magnet: buildMagnetUri(hash, title),
        size: t.size_bytes || (t.size ? parseHumanBytes(t.size) : 0),
        sizeStr: t.size || '',
        seeders: Number(t.seeds) || 0,
        leechers: Number(t.peers) || 0,
        category: 'Movies',
        indexer: 'YTS',
        poster: movie.medium_cover_image || movie.small_cover_image || null,
        rating: movie.rating || null,
        year: movie.year || null,
        genres: movie.genres || [],
      });
    }
  }

  return results;
}

/**
 * Search EZTV for TV Shows
 */
export async function searchEZTV(query) {
  if (!query || !query.trim()) return [];
  const mirrors = ['https://eztvx.to', 'https://eztv.re', 'https://eztv.wf'];
  let torrents = null;

  for (const mirror of mirrors) {
    try {
      const url = `${mirror}/api/get-torrents?limit=25&query_term=${encodeURIComponent(query.trim())}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const json = await res.json();
        if (json?.torrents && Array.isArray(json.torrents)) {
          torrents = json.torrents;
          break;
        }
      }
    } catch {}
  }

  if (!torrents) return [];

  return torrents
    .filter((t) => t.title && (t.magnet_url || t.hash))
    .map((t) => {
      const hash = t.hash ? t.hash.toLowerCase() : extractHashFromMagnet(t.magnet_url);
      return {
        title: t.title,
        infoHash: hash,
        magnet: t.magnet_url || buildMagnetUri(hash, t.title),
        size: Number(t.size_bytes) || 0,
        sizeStr: formatBytes(Number(t.size_bytes) || 0),
        seeders: Number(t.seeds) || 0,
        leechers: Number(t.peers) || 0,
        category: 'TV Shows',
        indexer: 'EZTV',
        poster: t.small_screenshot ? (t.small_screenshot.startsWith('//') ? `https:${t.small_screenshot}` : t.small_screenshot) : null,
        episodeUrl: t.episode_url || null,
      };
    });
}

/**
 * Search Nyaa for Anime releases
 */
export async function searchNyaa(query) {
  if (!query || !query.trim()) return [];
  const url = `https://nyaa.si/?f=0&c=0_0&q=${encodeURIComponent(query.trim())}&page=rss`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(6000),
  });

  if (!res.ok) throw new Error(`Nyaa HTTP ${res.status}`);
  const xml = await res.text();

  const items = [];
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/gi);

  for (const match of itemMatches) {
    const itemContent = match[1];
    const titleMatch = itemContent.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i) || itemContent.match(/<title>(.*?)<\/title>/i);
    const linkMatch = itemContent.match(/<link>(.*?)<\/link>/i);
    const seedersMatch = itemContent.match(/<nyaa:seeders>(\d+)<\/nyaa:seeders>/i);
    const leechersMatch = itemContent.match(/<nyaa:leechers>(\d+)<\/nyaa:leechers>/i);
    const sizeMatch = itemContent.match(/<nyaa:size>(.*?)<\/nyaa:size>/i);
    const pubDateMatch = itemContent.match(/<pubDate>(.*?)<\/pubDate>/i);

    const title = titleMatch ? titleMatch[1].trim() : '';
    const link = linkMatch ? linkMatch[1].trim() : '';
    const hash = extractHashFromMagnet(link);

    if (title && (link || hash)) {
      items.push({
        title,
        infoHash: hash,
        magnet: link.startsWith('magnet:') ? link : buildMagnetUri(hash, title),
        size: sizeMatch ? parseHumanBytes(sizeMatch[1]) : 0,
        sizeStr: sizeMatch ? sizeMatch[1] : '',
        seeders: seedersMatch ? Number(seedersMatch[1]) : 0,
        leechers: leechersMatch ? Number(leechersMatch[1]) : 0,
        category: 'Anime',
        indexer: 'Nyaa',
        uploadedAt: pubDateMatch ? pubDateMatch[1] : null,
      });
    }
  }

  return items;
}

/**
 * Search custom Jackett / Prowlarr instance
 */
export async function searchJackett(query, jackettUrl, jackettApiKey) {
  if (!jackettUrl || !jackettApiKey || !query || !query.trim()) return [];
  const cleanUrl = jackettUrl.replace(/\/+$/, '');
  const url = `${cleanUrl}/api/v2.0/indexers/all/results?apikey=${encodeURIComponent(jackettApiKey)}&Query=${encodeURIComponent(query.trim())}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Jackett HTTP ${res.status}`);
  const json = await res.json();
  if (!json?.Results || !Array.isArray(json.Results)) return [];

  return json.Results.map((r) => {
    const hash = r.InfoHash ? r.InfoHash.toLowerCase() : extractHashFromMagnet(r.MagnetUri);
    const sizeBytes = Number(r.Size) || 0;
    return {
      title: r.Title || 'Unknown Release',
      infoHash: hash,
      magnet: r.MagnetUri || (r.Link && r.Link.startsWith('magnet:') ? r.Link : buildMagnetUri(hash, r.Title)),
      torrentUrl: r.Link && !r.Link.startsWith('magnet:') ? r.Link : null,
      size: sizeBytes,
      sizeStr: formatBytes(sizeBytes),
      seeders: Number(r.Seeders) || 0,
      leechers: Number(r.Peers) || 0,
      category: r.CategoryDesc || 'Torznab',
      indexer: r.Tracker || 'Jackett',
      uploadedAt: r.PublishDate || null,
    };
  });
}

/**
 * Aggregates all search providers concurrently, deduplicates by infohash,
 * and enriches results with AllDebrid Instant Cloud Cache telemetry
 */
export async function searchAggregator(query, options = {}) {
  const {
    category = 'all',
    onlyCached = false,
    alldebridClient = null,
    jackettUrl = process.env.JACKETT_URL || '',
    jackettApiKey = process.env.JACKETT_API_KEY || '',
  } = options;

  if (!query || !query.trim()) {
    return { results: [], total: 0, query: '', instantCount: 0 };
  }

  const cleanQuery = query.trim();
  const tasks = [];

  // Determine which providers to invoke based on category filter
  const catLower = category.toLowerCase();

  if (catLower === 'all' || catLower === 'movies') {
    tasks.push(searchYTS(cleanQuery).catch((err) => (console.warn('[Search] YTS error:', err.message), [])));
  }
  if (catLower === 'all' || catLower === 'tv' || catLower === 'tv shows') {
    tasks.push(searchEZTV(cleanQuery).catch((err) => (console.warn('[Search] EZTV error:', err.message), [])));
  }
  if (catLower === 'all' || catLower === 'anime') {
    tasks.push(searchNyaa(cleanQuery).catch((err) => (console.warn('[Search] Nyaa error:', err.message), [])));
  }
  if (catLower === 'all' || catLower === 'games' || catLower === 'apps' || catLower === 'movies' || catLower === 'tv') {
    tasks.push(searchPirateBay(cleanQuery).catch((err) => (console.warn('[Search] PirateBay error:', err.message), [])));
  }

  if (jackettUrl && jackettApiKey) {
    tasks.push(searchJackett(cleanQuery, jackettUrl, jackettApiKey).catch((err) => (console.warn('[Search] Jackett error:', err.message), [])));
  }

  const settled = await Promise.allSettled(tasks);
  let allResults = [];

  for (const s of settled) {
    if (s.status === 'fulfilled' && Array.isArray(s.value)) {
      allResults.push(...s.value);
    }
  }

  // Deduplicate by InfoHash
  const seenHashes = new Set();
  const deduplicated = [];

  for (const item of allResults) {
    if (!item.infoHash) {
      deduplicated.push(item);
      continue;
    }
    const hashKey = item.infoHash.toLowerCase();
    if (!seenHashes.has(hashKey)) {
      seenHashes.add(hashKey);
      deduplicated.push(item);
    }
  }

  // Sort by seeders descending
  deduplicated.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));

  // Enrich with AllDebrid Instant Cloud Cache telemetry
  let instantCount = 0;
  if (alldebridClient && deduplicated.length > 0) {
    // Collect top 60 hashes to check with AllDebrid
    const targetItems = deduplicated.slice(0, 60);
    const hashesToCheck = targetItems.map((r) => r.infoHash).filter(Boolean);

    if (hashesToCheck.length > 0) {
      try {
        const instantMap = new Map();
        // Check in chunks of 25 to respect API guidelines
        for (let i = 0; i < hashesToCheck.length; i += 25) {
          const chunk = hashesToCheck.slice(i, i + 25);
          const cacheResults = await alldebridClient.checkInstantAvailability(chunk);
          if (Array.isArray(cacheResults)) {
            for (const item of cacheResults) {
              if (item?.hash) {
                instantMap.set(item.hash.toLowerCase(), {
                  ready: !!item.ready,
                  name: item.name || null,
                  size: item.size || null,
                  alldebridId: item.id || null,
                });
              }
            }
          }
        }

        for (const item of deduplicated) {
          if (item.infoHash && instantMap.has(item.infoHash.toLowerCase())) {
            const cacheInfo = instantMap.get(item.infoHash.toLowerCase());
            item.instant = cacheInfo.ready;
            item.alldebridReady = cacheInfo.ready;
            item.alldebridId = cacheInfo.alldebridId;
            if (cacheInfo.ready) instantCount++;
          } else {
            item.instant = false;
            item.alldebridReady = false;
          }
        }
      } catch (err) {
        console.warn('[Search] Failed to check AllDebrid instant cache:', err.message);
      }
    }
  }

  // Filter if user requested only instant-cached releases
  let finalResults = deduplicated;
  if (onlyCached) {
    finalResults = deduplicated.filter((r) => r.instant === true);
  } else {
    // Sort instant-cached items to the top while preserving seeder ordering
    finalResults.sort((a, b) => {
      if (a.instant && !b.instant) return -1;
      if (!a.instant && b.instant) return 1;
      return (b.seeders || 0) - (a.seeders || 0);
    });
  }

  return {
    results: finalResults,
    total: finalResults.length,
    query: cleanQuery,
    instantCount,
  };
}
