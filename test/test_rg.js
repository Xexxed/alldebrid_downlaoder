import { AllDebridClient } from '../server/alldebrid.js';

async function testRapidgatorFolder() {
  const url = 'https://rapidgator.net/folder/8673733/MindValleyBecomingIrresistiblySexy.html?referer=https://tutbb.com/';
  console.log('Testing url:', url);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    }
  });

  const html = await res.text();
  console.log('HTML size:', html.length);

  // Match folder name
  const titleMatch = html.match(/<div id="table_header"[^>]*>([\s\S]*?)<br>/i) || html.match(/Downloading:\s*<\/strong>\s*([^<]+)/i) || html.match(/<title>Download file\s*([^<]+)<\/title>/i);
  const folderName = titleMatch ? titleMatch[1].trim() : 'Rapidgator_Folder';
  console.log('Folder Name:', folderName);

  // Match file links
  // Pattern: href="/file/<id>/<filename>.html"
  const linkRegex = /href=["'](\/file\/[a-zA-Z0-9_-]+\/[^"']+)["']/gi;
  const fileLinks = [];
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    const fullLink = m[1].startsWith('http') ? m[1] : `https://rapidgator.net${m[1]}`;
    if (!fileLinks.includes(fullLink)) {
      fileLinks.push(fullLink);
    }
  }

  console.log('Extracted files count:', fileLinks.length);
  console.log('Files:', fileLinks);
}

testRapidgatorFolder().catch(console.error);
