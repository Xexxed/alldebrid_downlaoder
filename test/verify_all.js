import { fetchRapidgatorFolder, parseDownloadInput } from '../server/alldebrid.js';
import { detectExtractor, detectArchiveGroups, isArchiveFile, extractArchive } from '../server/extractor.js';
import fs from 'fs';
import path from 'path';

async function runVerification() {
  console.log('=== STARTING ALLDEBRID DOWNLOADER VERIFICATION ===\n');

  // Test 1: Extractor Tooling & Archive Detection
  console.log('--- Test 1: Archive Extractor Tooling & Detection ---');
  const extractor = detectExtractor();
  console.log('Detected Extractor:', extractor);
  if (!extractor || !extractor.path) {
    throw new Error('No extractor tool detected on system!');
  }
  console.log('✓ Extractor tooling verified.');

  const sampleFiles = [
    'rcotv.MindValley..Becoming.Irresistibly.Sexy.part1.rar',
    'rcotv.MindValley..Becoming.Irresistibly.Sexy.part2.rar',
    'rcotv.MindValley..Becoming.Irresistibly.Sexy.part3.rar',
    'rcotv.MindValley..Becoming.Irresistibly.Sexy.part4.rar',
    'rcotv.MindValley..Becoming.Irresistibly.Sexy.part5.rar',
    'rcotv.MindValley..Becoming.Irresistibly.Sexy.part6.rar',
    'rcotv.MindValley..Becoming.Irresistibly.Sexy.part7.rar',
    'rcotv.MindValley..Becoming.Irresistibly.Sexy.part8.rar',
  ];

  for (const f of sampleFiles) {
    if (!isArchiveFile(f)) {
      throw new Error(`File ${f} was not recognized as an archive!`);
    }
  }
  console.log('✓ isArchiveFile correctly classified all 8 part files.');

  const groups = detectArchiveGroups(sampleFiles);
  console.log('Detected Groups count:', groups.length);
  if (groups.length !== 1 || groups[0].type !== 'multipart_rar') {
    throw new Error(`Expected 1 multipart_rar group, got ${JSON.stringify(groups)}`);
  }
  if (!groups[0].entryFile.endsWith('part1.rar')) {
    throw new Error(`Expected entryFile to be part1.rar, got ${groups[0].entryFile}`);
  }
  if (groups[0].partFiles.length !== 8) {
    throw new Error(`Expected 8 partFiles, got ${groups[0].partFiles.length}`);
  }
  console.log('✓ detectArchiveGroups correctly grouped 8 part files with entryFile = part1.rar.\n');

  // Test 2: Rapidgator Folder Scraper
  console.log('--- Test 2: Rapidgator Folder Scraper ---');
  const rgUrl = 'https://rapidgator.net/folder/8673733/MindValleyBecomingIrresistiblySexy.html?referer=https://tutbb.com/';
  console.log('Scraping folder URL:', rgUrl);
  
  const parsedInputs = parseDownloadInput(rgUrl);
  console.log('parseDownloadInput result:', parsedInputs);
  if (parsedInputs.length !== 1 || parsedInputs[0].type !== 'folderLink') {
    throw new Error(`Expected folderLink type, got ${JSON.stringify(parsedInputs)}`);
  }
  console.log('✓ parseDownloadInput recognized rapidgator folderLink.');

  const folderResult = await fetchRapidgatorFolder(rgUrl);
  console.log('Folder Name:', folderResult.folderName);
  console.log('Files count:', folderResult.files.length);
  console.log('Total Size:', folderResult.totalSize, `(~${(folderResult.totalSize / (1024*1024*1024)).toFixed(2)} GB)`);

  if (folderResult.files.length !== 8) {
    throw new Error(`Expected 8 files in Rapidgator folder, got ${folderResult.files.length}`);
  }
  if (!folderResult.folderName.includes('MindValley')) {
    throw new Error(`Expected folderName to contain MindValley, got ${folderResult.folderName}`);
  }
  console.log('✓ Rapidgator folder scraper parsed all 8 files with metadata.\n');

  // Test 3: Live Express API /api/downloads/preview
  console.log('--- Test 3: Local Server API /api/downloads/preview ---');
  const apiRes = await fetch('http://localhost:3000/api/downloads/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: rgUrl }),
  });

  const apiData = await apiRes.json();
  console.log('Preview API Response status:', apiRes.status);
  console.log('Preview count:', apiData.previews?.length);
  console.log('Preview item:', {
    type: apiData.previews?.[0]?.type,
    name: apiData.previews?.[0]?.name,
    totalSize: apiData.previews?.[0]?.totalSize,
    fileCount: apiData.previews?.[0]?.flattenedFiles?.length,
    hasArchives: apiData.previews?.[0]?.hasArchives,
    defaultOutputDir: apiData.previews?.[0]?.defaultOutputDir,
  });

  if (!apiData.previews || apiData.previews.length === 0) {
    throw new Error(`Preview failed: ${JSON.stringify(apiData)}`);
  }
  const prev = apiData.previews[0];
  if (prev.type !== 'folder') throw new Error(`Expected type folder, got ${prev.type}`);
  if (prev.flattenedFiles.length !== 8) throw new Error(`Expected 8 files, got ${prev.flattenedFiles.length}`);
  if (!prev.hasArchives) throw new Error('Expected hasArchives to be true');

  console.log('✓ Live API /api/downloads/preview returned full folder preview with archive flag.\n');

  console.log('=== ALL TESTS PASSED SUCCESSFULLY! ===');
}

runVerification().catch((err) => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});
