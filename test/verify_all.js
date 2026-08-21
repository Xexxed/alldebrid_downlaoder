import { fetchRapidgatorFolder, parseDownloadInput } from '../server/alldebrid.js';
import { detectExtractor, detectArchiveGroups, isArchiveFile } from '../server/extractor.js';
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
    'archive_dataset.part1.rar',
    'archive_dataset.part2.rar',
    'archive_dataset.part3.rar',
    'archive_dataset.part4.rar',
    'archive_dataset.part5.rar',
    'archive_dataset.part6.rar',
    'archive_dataset.part7.rar',
    'archive_dataset.part8.rar',
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

  // Test 2: Rapidgator Folder Scraper & URL parser
  console.log('--- Test 2: Rapidgator Folder URL Parser ---');
  const sampleFolderUrl = 'https://rapidgator.net/folder/1234567/SamplePackage.html';
  const parsedInputs = parseDownloadInput(sampleFolderUrl);
  console.log('parseDownloadInput result:', parsedInputs);
  if (parsedInputs.length !== 1 || parsedInputs[0].type !== 'folderLink') {
    throw new Error(`Expected folderLink type, got ${JSON.stringify(parsedInputs)}`);
  }
  console.log('✓ parseDownloadInput recognized rapidgator folderLink.');

  // Test 3: Multiple Link Types Recognition
  console.log('--- Test 3: Link Parser Multi-Format Verification ---');
  const multiInput = `
https://rapidgator.net/folder/9999999/SampleArchives.html
https://alldebrid.com/getMagnet/123456789
magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567
https://hoster.com/file/sample_video.mp4
`;
  const parsedBatch = parseDownloadInput(multiInput);
  console.log('Parsed batch types:', parsedBatch.map(p => p.type));
  if (parsedBatch.length !== 4) {
    throw new Error(`Expected 4 parsed items, got ${parsedBatch.length}`);
  }
  if (parsedBatch[0].type !== 'folderLink') throw new Error('Item 0 should be folderLink');
  if (parsedBatch[1].type !== 'getMagnet') throw new Error('Item 1 should be getMagnet');
  if (parsedBatch[2].type !== 'magnet') throw new Error('Item 2 should be magnet');
  if (parsedBatch[3].type !== 'directLink') throw new Error('Item 3 should be directLink');

  console.log('✓ Multi-format parser successfully classified folderLink, getMagnet, magnet, and directLink.\n');

  console.log('=== ALL TESTS PASSED SUCCESSFULLY! ===');
}

runVerification().catch((err) => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});
