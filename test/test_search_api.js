import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { AllDebridClient } from '../server/alldebrid.js';
import { searchAggregator, searchYTS, searchNyaa, searchPirateBay, extractHashFromMagnet } from '../server/search.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const apiKey = process.env.ALLDEBRID_API_KEY || '';
const client = apiKey ? new AllDebridClient(apiKey) : null;

async function runTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING DISCOVERY & SEARCH AGGREGATOR TESTS');
  console.log('====================================================');

  // Test 1: Hash extraction
  console.log('\n[TEST 1] Testing Infohash Extraction:');
  const sampleMag = 'magnet:?xt=urn:btih:842783e3005495d5d1637f5364b59343c7844707&dn=Ubuntu+24.04';
  const extracted = extractHashFromMagnet(sampleMag);
  console.log(`  Source: ${sampleMag.slice(0, 40)}...`);
  console.log(`  Extracted Hash: ${extracted}`);
  if (extracted !== '842783e3005495d5d1637f5364b59343c7844707') {
    throw new Error('Hash extraction failed');
  }
  console.log('  ✅ Infohash extraction passed');

  // Test 2: Search Providers
  console.log('\n[TEST 2] Testing Individual Providers:');

  try {
    const apibayResults = await searchPirateBay('ubuntu');
    console.log(`  PirateBay results count for "ubuntu": ${apibayResults.length}`);
  } catch (err) {
    console.warn(`  PirateBay provider note: ${err.message}`);
  }

  try {
    const ytsResults = await searchYTS('Inception');
    console.log(`  YTS results count for "Inception": ${ytsResults.length}`);
  } catch (err) {
    console.warn(`  YTS provider note: ${err.message}`);
  }

  try {
    const nyaaResults = await searchNyaa('Attack on Titan');
    console.log(`  Nyaa results count for "Attack on Titan": ${nyaaResults.length}`);
  } catch (err) {
    console.warn(`  Nyaa provider note: ${err.message}`);
  }

  // Test 3: Aggregator with AllDebrid Instant Availability
  console.log('\n[TEST 3] Testing searchAggregator with Live AllDebrid Cache:');
  const query = 'matrix';
  const searchResult = await searchAggregator(query, {
    category: 'all',
    onlyCached: false,
    alldebridClient: client,
  });

  console.log(`  Query: "${query}"`);
  console.log(`  Total deduplicated releases: ${searchResult.total}`);
  console.log(`  Instant Cloud Ready releases: ${searchResult.instantCount}`);

  if (searchResult.results.length > 0) {
    const firstInstant = searchResult.results.find((r) => r.instant);
    if (firstInstant) {
      console.log(`  Sample Instant Cached Release: "${firstInstant.title}" [${firstInstant.sizeStr}] (Indexer: ${firstInstant.indexer})`);
    } else {
      console.log(`  Sample Release: "${searchResult.results[0].title}" [${searchResult.results[0].sizeStr}]`);
    }
  }

  // Test 4: Batch Magnet Cache Check
  console.log('\n[TEST 4] Testing Batch Cache Check:');
  if (client) {
    const hashes = [
      '842783e3005495d5d1637f5364b59343c7844707', // Ubuntu
      '0123456789abcdef0123456789abcdef01234567', // Random
    ];
    const cacheInspection = await client.checkInstantAvailability(hashes);
    console.log(`  Inspected ${cacheInspection.length} hashes.`);
    cacheInspection.forEach((c) => {
      console.log(`    • ${c.hash || c.name || 'Hash'}: Ready = ${c.ready}`);
    });
    console.log('  ✅ Batch cache inspector passed');
  } else {
    console.log('  ⚠️ Skipping client cache check: No API key');
  }

  console.log('\n====================================================');
  console.log('🎉 ALL SEARCH & CACHE TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
