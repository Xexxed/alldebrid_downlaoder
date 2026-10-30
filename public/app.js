/**
 * AllDebrid Core — High Performance Computing (HPC) Frontend Application
 * Implementation: design.md
 */

// Application State
const state = {
  tasks: new Map(),
  globalSpeed: 0,
  activeTab: 'active',
  cloudMagnets: [],
  settings: {
    hasApiKey: false,
    downloadDir: '',
    maxConcurrent: 3,
  },
  selectedTorrentFiles: [],
  currentTreeTaskId: null,
  // Review Modal State
  reviewPreviews: [],
  reviewSelectedPaths: new Set(),
  // Folder Browser State
  browserCurrentPath: '',
  browserParentPath: null,
  onFolderSelectedCallback: null,
  // Search & Discover State
  searchQuery: '',
  searchCategory: 'all',
  searchResults: [],
  isSearching: false,
  // Cloud Manager State
  cloudSelection: new Set(),
  cloudSortMode: 'default',
  stats: null,
};

// ============================================================
// Auth Token Handling & API Wrapper
// ============================================================

const TOKEN_STORAGE_KEY = 'adc_auth_token';

function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function storeToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {}
}

function withToken(url) {
  return url;
}

async function apiFetch(url, options = {}) {
  const token = getStoredToken();
  const headers = new Headers(options.headers);
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(withToken(url), { ...options, headers });

  if (res.status === 401) {
    showTokenModal();
    throw new Error('Unauthorized: valid access token required');
  }

  if (res && typeof res.text === 'function') {
    res.json = async () => {
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        if (!res.ok) {
          throw new Error(`Server error HTTP ${res.status}: ${res.statusText || 'Request failed'}`);
        }
        throw new Error('Invalid JSON response received from server');
      }
    };
  }

  return res;
}

function showTokenModal() {
  const modal = document.getElementById('tokenAuthModal');
  if (!modal || !modal.classList.contains('active')) {
    if (modal) {
      modal.classList.add('active');
      const input = document.getElementById('tokenAuthInput');
      if (input) {
        input.value = getStoredToken();
        setTimeout(() => input.focus(), 50);
      }
    }
  }
}

window.submitAuthToken = async function () {
  const input = document.getElementById('tokenAuthInput');
  const token = (input?.value || '').trim();
  try {
    const res = await apiFetch('/api/auth-check', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.tokenValid) {
      storeToken(token);
      document.getElementById('tokenAuthModal').classList.remove('active');
      showToast('Access token accepted', 'success');
      connectWebSocket();
      fetchStatus();
    } else {
      showToast('Invalid access token', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// DOM Elements
const elements = {
  globalSpeed: document.getElementById('globalSpeed'),
  userPill: document.getElementById('userPill'),
  userStatusIcon: document.getElementById('userStatusIcon'),
  userStatusLabel: document.getElementById('userStatusLabel'),
  userStatusValue: document.getElementById('userStatusValue'),
  wsStatus: document.getElementById('wsStatus'),
  activeCount: document.getElementById('activeCount'),
  completedCount: document.getElementById('completedCount'),
  cloudCount: document.getElementById('cloudCount'),
  activeTasksList: document.getElementById('activeTasksList'),
  completedTasksList: document.getElementById('completedTasksList'),
  cloudTorrentsList: document.getElementById('cloudTorrentsList'),
  activeSearchInput: document.getElementById('activeSearchInput'),
  completedSearchInput: document.getElementById('completedSearchInput'),
  cloudSearchInput: document.getElementById('cloudSearchInput'),
  activeStatsText: document.getElementById('activeStatsText'),
  completedStatsText: document.getElementById('completedStatsText'),
  emptyActiveState: document.getElementById('emptyActiveState'),
  emptyCompletedState: document.getElementById('emptyCompletedState'),
  refreshCloudBtn: document.getElementById('refreshCloudBtn'),
  // Add Modal
  openAddModalBtn: document.getElementById('openAddModalBtn'),
  addDownloadModal: document.getElementById('addDownloadModal'),
  closeAddModalBtn: document.getElementById('closeAddModalBtn'),
  cancelAddBtn: document.getElementById('cancelAddBtn'),
  submitAddBtn: document.getElementById('submitAddBtn'),
  downloadInputText: document.getElementById('downloadInputText'),
  // Torrent Upload
  torrentDropzone: document.getElementById('torrentDropzone'),
  torrentFileInput: document.getElementById('torrentFileInput'),
  selectedFilesList: document.getElementById('selectedFilesList'),
  cancelUploadBtn: document.getElementById('cancelUploadBtn'),
  submitUploadBtn: document.getElementById('submitUploadBtn'),
  // Download Review Modal
  downloadReviewModal: document.getElementById('downloadReviewModal'),
  closeReviewModalBtn: document.getElementById('closeReviewModalBtn'),
  cancelReviewBtn: document.getElementById('cancelReviewBtn'),
  confirmReviewDownloadBtn: document.getElementById('confirmReviewDownloadBtn'),
  reviewTorrentName: document.getElementById('reviewTorrentName'),
  reviewTotalSize: document.getElementById('reviewTotalSize'),
  reviewFileCount: document.getElementById('reviewFileCount'),
  reviewStatusBadge: document.getElementById('reviewStatusBadge'),
  reviewOutputDirInput: document.getElementById('reviewOutputDirInput'),
  changeReviewDirBtn: document.getElementById('changeReviewDirBtn'),
  reviewSelectedCount: document.getElementById('reviewSelectedCount'),
  selectAllReviewFilesBtn: document.getElementById('selectAllReviewFilesBtn'),
  deselectAllReviewFilesBtn: document.getElementById('deselectAllReviewFilesBtn'),
  reviewTreeContainer: document.getElementById('reviewTreeContainer'),
  reviewAutoExtractCheckbox: document.getElementById('reviewAutoExtractCheckbox'),
  reviewDeletePartsCheckbox: document.getElementById('reviewDeletePartsCheckbox'),
  archiveOptionsCard: document.getElementById('archiveOptionsCard'),
  deletePartsCard: document.getElementById('deletePartsCard'),
  // Folder Browser Modal
  folderBrowserModal: document.getElementById('folderBrowserModal'),
  closeFolderBrowserBtn: document.getElementById('closeFolderBrowserBtn'),
  cancelFolderBrowserBtn: document.getElementById('cancelFolderBrowserBtn'),
  selectFolderConfirmBtn: document.getElementById('selectFolderConfirmBtn'),
  browserDrivesBar: document.getElementById('browserDrivesBar'),
  browserUpDirBtn: document.getElementById('browserUpDirBtn'),
  browserCurrentPathText: document.getElementById('browserCurrentPathText'),
  browserFoldersList: document.getElementById('browserFoldersList'),
  newFolderNameInput: document.getElementById('newFolderNameInput'),
  createFolderBtn: document.getElementById('createFolderBtn'),
  // File Tree Modal
  fileTreeModal: document.getElementById('fileTreeModal'),
  closeTreeModalBtn: document.getElementById('closeTreeModalBtn'),
  closeTreeModalBottomBtn: document.getElementById('closeTreeModalBottomBtn'),
  treeModalTitle: document.getElementById('treeModalTitle'),
  treeContentArea: document.getElementById('treeContentArea'),
  openLocalFolderFromTreeBtn: document.getElementById('openLocalFolderFromTreeBtn'),
  // Settings
  settingsForm: document.getElementById('settingsForm'),
  apiKeyInput: document.getElementById('apiKeyInput'),
  toggleApiKeyVisibility: document.getElementById('toggleApiKeyVisibility'),
  downloadDirInput: document.getElementById('downloadDirInput'),
  browseDownloadDirBtn: document.getElementById('browseDownloadDirBtn'),
  maxConcurrentRange: document.getElementById('maxConcurrentRange'),
  maxConcurrentVal: document.getElementById('maxConcurrentVal'),
  jackettUrlInput: document.getElementById('jackettUrlInput'),
  jackettApiKeyInput: document.getElementById('jackettApiKeyInput'),
  testApiBtn: document.getElementById('testApiBtn'),
  // Extended engine settings
  speedLimitInput: document.getElementById('speedLimitInput'),
  maxRetriesInput: document.getElementById('maxRetriesInput'),
  minFreeGbInput: document.getElementById('minFreeGbInput'),
  scheduleEnabledCheckbox: document.getElementById('scheduleEnabledCheckbox'),
  scheduleStartInput: document.getElementById('scheduleStartInput'),
  scheduleEndInput: document.getElementById('scheduleEndInput'),
  scheduleLimitInput: document.getElementById('scheduleLimitInput'),
  authTokenInput: document.getElementById('authTokenInput'),
  authTokenMasked: document.getElementById('authTokenMasked'),
  // Cloud manager
  cloudSelectAllCheckbox: document.getElementById('cloudSelectAllCheckbox'),
  cloudSortSelect: document.getElementById('cloudSortSelect'),
  cloudBulkDeleteBtn: document.getElementById('cloudBulkDeleteBtn'),
  cloudUsageBar: document.getElementById('cloudUsageBar'),
  cloudUsageText: document.getElementById('cloudUsageText'),
  // Stats
  todayDownloaded: document.getElementById('todayDownloaded'),
  // Search & Discover
  torrentSearchInput: document.getElementById('torrentSearchInput'),
  triggerSearchBtn: document.getElementById('triggerSearchBtn'),
  searchCategoryPills: document.getElementById('searchCategoryPills'),
  onlyCachedCheckbox: document.getElementById('onlyCachedCheckbox'),
  searchMetaBar: document.getElementById('searchMetaBar'),
  searchResultTotal: document.getElementById('searchResultTotal'),
  searchResultInstant: document.getElementById('searchResultInstant'),
  searchResultsContainer: document.getElementById('searchResultsContainer'),
  searchSkeleton: document.getElementById('searchSkeleton'),
  searchInstantBadge: document.getElementById('searchInstantBadge'),
  // Batch Cache Checker Modal
  openBatchCacheModalBtn: document.getElementById('openBatchCacheModalBtn'),
  batchCacheModal: document.getElementById('batchCacheModal'),
  closeBatchCacheModalBtn: document.getElementById('closeBatchCacheModalBtn'),
  closeBatchCacheModalBottomBtn: document.getElementById('closeBatchCacheModalBottomBtn'),
  batchCacheTextarea: document.getElementById('batchCacheTextarea'),
  runBatchCacheCheckBtn: document.getElementById('runBatchCacheCheckBtn'),
  batchCacheResultsContainer: document.getElementById('batchCacheResultsContainer'),
  batchCacheTbody: document.getElementById('batchCacheTbody'),
  batchCacheSummaryText: document.getElementById('batchCacheSummaryText'),
  // Toast
  toastContainer: document.getElementById('toastContainer'),
};

// ============================================================
// SVG Icon System (No Emojis per design.md)
// ============================================================

const ICONS = {
  video: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>`,
  audio: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
  archive: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`,
  document: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
  image: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
  folder: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  cloud: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`,
  link: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  check: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`,
  alert: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  info: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  pause: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
  play: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  retry: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
  trash: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  drive: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/></svg>`,
};

// ============================================================
// Formatting Utilities
// ============================================================

function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0.00 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec) {
  return formatBytes(bytesPerSec) + '/s';
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return '--';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getFileIconSvg(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts'];
  const audioExts = ['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a'];
  const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz', 'iso'];
  const docExts = ['pdf', 'epub', 'txt', 'nfo', 'doc', 'docx'];
  const imgExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];

  if (videoExts.includes(ext)) return ICONS.video;
  if (audioExts.includes(ext)) return ICONS.audio;
  if (archiveExts.includes(ext)) return ICONS.archive;
  if (docExts.includes(ext)) return ICONS.document;
  if (imgExts.includes(ext)) return ICONS.image;
  return ICONS.document;
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `hpc-toast ${type}`;
  const iconSvg = type === 'success' ? ICONS.check : type === 'error' ? ICONS.alert : ICONS.info;
  toast.innerHTML = `<div class="toast-icon">${iconSvg}</div><span>${message}</span>`;
  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'opacity 0.25s ease-out, transform 0.25s ease-out';
    setTimeout(() => toast.remove(), 260);
  }, 4200);
}

// ============================================================
// WebSocket Connection & Real-Time Sync
// ============================================================

let ws = null;
let reconnectTimer = null;

async function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let wsUrl = `${protocol}//${window.location.host}`;

  // Authenticated servers require a short-lived single-use ticket; the token
  // itself never travels in the socket URL.
  if (getStoredToken()) {
    try {
      const ticketRes = await apiFetch('/api/ws-ticket', { method: 'POST' });
      if (!ticketRes.ok) throw new Error('ticket request failed');
      const { ticket } = await ticketRes.json();
      wsUrl = `${wsUrl}?ticket=${encodeURIComponent(ticket)}`;
    } catch {
      scheduleReconnect();
      return;
    }
  }

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    elements.wsStatus.innerHTML = '<span class="socket-text text-success">Connected</span>';
    if (reconnectTimer) clearTimeout(reconnectTimer);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWsMessage(data);
    } catch (err) {
      console.error('Error parsing WS message:', err);
    }
  };

  ws.onclose = () => {
    elements.wsStatus.innerHTML = '<span class="socket-text text-warning">Reconnecting</span>';
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws.close();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWebSocket, 2500);
}

function handleWsMessage(msg) {
  if (msg.type === 'initial_state' || msg.type === 'progress_tick') {
    if (msg.tasks) {
      state.tasks.clear();
      msg.tasks.forEach((t) => state.tasks.set(t.id, t));
    }
    state.globalSpeed = msg.globalSpeed || 0;
    renderTasks();
    updateGlobalStats();
  } else if (msg.type === 'task_added' || msg.type === 'task_updated') {
    state.tasks.set(msg.task.id, msg.task);
    renderTasks();
    updateGlobalStats();
  } else if (msg.type === 'task_completed') {
    state.tasks.set(msg.task.id, msg.task);
    renderTasks();
    updateGlobalStats();
    showToast(`Task Complete: ${msg.task.name}`, 'success');
  } else if (msg.type === 'task_deleted') {
    state.tasks.delete(msg.taskId);
    renderTasks();
    updateGlobalStats();
  } else if (msg.type === 'disk_warning') {
    showToast(msg.message, 'error');
    renderTasks();
  }
}

// ============================================================
// API Calls & Account Status
// ============================================================

async function fetchStatus() {
  try {
    const res = await apiFetch('/api/status');
    const data = await res.json();

    state.settings.hasApiKey = data.hasApiKey;
    state.settings.downloadDir = data.downloadDir;
    state.settings.maxConcurrent = data.maxConcurrent;

    if (data.userInfo) {
      const u = data.userInfo;
      const isPrem = u.isPremium;
      elements.userStatusLabel.textContent = isPrem ? 'Premium account' : 'Standard account';
      elements.userStatusValue.textContent = `${u.username || 'User'}`;
      elements.userPill.dataset.state = isPrem ? 'premium' : 'warning';
    } else if (data.hasApiKey && data.userError) {
      elements.userStatusLabel.textContent = 'Account';
      elements.userStatusValue.textContent = 'Sign-in failed';
      elements.userPill.dataset.state = 'error';
    } else {
      elements.userStatusLabel.textContent = 'Account';
      elements.userStatusValue.textContent = 'API key not set';
      elements.userPill.dataset.state = 'warning';
    }

    // Populate settings form
    elements.downloadDirInput.value = data.downloadDir || '';
    elements.maxConcurrentRange.value = data.maxConcurrent || 3;
    elements.maxConcurrentVal.textContent = `${data.maxConcurrent || 3} workers`;

    // Fetch extended settings (Jackett, limits, schedule)
    const setRes = await apiFetch('/api/settings');
    const setData = await setRes.json();
    if (setData.jackettUrl && elements.jackettUrlInput) {
      elements.jackettUrlInput.value = setData.jackettUrl;
    }
    if (elements.speedLimitInput) {
      elements.speedLimitInput.value = setData.speedLimitKbps ?? 0;
    }
    if (elements.maxRetriesInput) {
      elements.maxRetriesInput.value = setData.maxRetries ?? 3;
    }
    if (elements.minFreeGbInput) {
      elements.minFreeGbInput.value = setData.minFreeGb ?? 5;
    }
    if (elements.scheduleEnabledCheckbox) {
      elements.scheduleEnabledCheckbox.checked = !!setData.scheduleEnabled;
      elements.scheduleStartInput.value = setData.scheduleStart || '';
      elements.scheduleEndInput.value = setData.scheduleEnd || '';
      elements.scheduleLimitInput.value = setData.scheduleLimitKbps ?? 0;
      syncScheduleFieldsState();
    }
    if (elements.authTokenMasked) {
      elements.authTokenMasked.textContent = setData.authTokenMasked || 'Not set';
      elements.authTokenInput.placeholder = setData.hasAuthToken ? `Current: ${setData.authTokenMasked}` : 'Set an access token';
    }

    // Fetch usage stats
    fetchStats();
  } catch (err) {
    console.error('Failed to fetch status:', err);
  }
}

async function fetchStats() {
  try {
    const res = await apiFetch('/api/stats');
    const data = await res.json();
    state.stats = data;

    const todayEl = document.getElementById('todayDownloaded');
    if (todayEl) todayEl.textContent = formatBytes(data.todayBytes || 0);

    const lifetimeTotal = document.getElementById('statsLifetimeBytes');
    if (lifetimeTotal) lifetimeTotal.textContent = formatBytes(data.totalBytes || 0);
    const peakSpeed = document.getElementById('statsPeakSpeed');
    if (peakSpeed) peakSpeed.textContent = formatSpeed(data.peakSpeed || 0);
    const activeTime = document.getElementById('statsActiveTime');
    if (activeTime) activeTime.textContent = formatEta(data.activeSeconds || 0);
  } catch (err) {
    console.error('Failed to fetch stats:', err);
  }
}

async function fetchCloudMagnets() {
  elements.cloudTorrentsList.innerHTML = `
    <div class="shimmer-block">
      <div class="shimmer-line header"></div>
      <div class="shimmer-line sub"></div>
      <div class="shimmer-line bar"></div>
    </div>
  `;

  try {
    const res = await apiFetch('/api/cloud-magnets');
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.cloudMagnets = data.magnets || [];
    renderCloudMagnets();
  } catch (err) {
    elements.cloudTorrentsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon-box text-danger">
          ${ICONS.alert}
        </div>
        <h2>Cloud sync failed</h2>
        <p>${err.message}</p>
        <button class="btn btn-secondary" onclick="fetchCloudMagnets()">Try again</button>
      </div>
    `;
  }
}

// ============================================================
// Render Logic
// ============================================================

function updateGlobalStats() {
  elements.globalSpeed.textContent = formatSpeed(state.globalSpeed);

  let activeCount = 0;
  let completedCount = 0;

  for (const t of state.tasks.values()) {
    if (t.status === 'completed') completedCount++;
    else activeCount++;
  }

  elements.activeCount.textContent = activeCount;
  elements.completedCount.textContent = completedCount;
  elements.activeStatsText.textContent = `${activeCount} active`;
  elements.completedStatsText.textContent = `${completedCount} completed`;
}

function renderTasks() {
  const activeQuery = elements.activeSearchInput.value.toLowerCase().trim();
  const completedQuery = elements.completedSearchInput.value.toLowerCase().trim();

  const allTasks = Array.from(state.tasks.values());
  const priorityOrder = { 0: 0, 1: 1, 2: 2 };
  const activeTasks = allTasks
    .filter((t) => t.status !== 'completed' && (!activeQuery || t.name.toLowerCase().includes(activeQuery)))
    .sort((a, b) => (priorityOrder[a.priority ?? 1] - priorityOrder[b.priority ?? 1]) || String(a.addedAt).localeCompare(String(b.addedAt)));
  const completedTasks = allTasks
    .filter((t) => t.status === 'completed' && (!completedQuery || t.name.toLowerCase().includes(completedQuery)))
    .sort((a, b) => String(b.completedAt || b.addedAt).localeCompare(String(a.completedAt || a.addedAt)));

  // Render Active
  if (activeTasks.length === 0) {
    elements.activeTasksList.innerHTML = '';
    elements.activeTasksList.appendChild(elements.emptyActiveState);
    elements.emptyActiveState.style.display = 'flex';
  } else {
    elements.emptyActiveState.style.display = 'none';
    elements.activeTasksList.innerHTML = activeTasks.map((t) => createTaskCardHtml(t)).join('');
  }

  // Render Completed
  if (completedTasks.length === 0) {
    elements.completedTasksList.innerHTML = '';
    elements.completedTasksList.appendChild(elements.emptyCompletedState);
    elements.emptyCompletedState.style.display = 'flex';
  } else {
    elements.emptyCompletedState.style.display = 'none';
    elements.completedTasksList.innerHTML = completedTasks.map((t) => createTaskCardHtml(t)).join('');
  }
}

function createTaskCardHtml(task) {
  const isCompleted = task.status === 'completed';
  const isDownloading = task.status === 'downloading';
  const isPaused = task.status === 'paused';
  const isError = task.status === 'error';
  const isWaitingCloud = task.status === 'waiting_cloud';
  const isExtracting = task.status === 'extracting' || task.isExtracting;

  const statusLabels = {
    pending: 'Queued',
    ready_to_download: 'Queued',
    initializing: 'Preparing',
    waiting_cloud: 'Waiting for cloud',
    downloading: 'Downloading',
    paused: 'Paused',
    extracting: 'Extracting',
    completed: 'Completed',
    error: 'Error',
    deleted_after_extract: 'Extracted',
  };
  let statusText = statusLabels[task.status] || task.status;
  if (isWaitingCloud) statusText = `Waiting for cloud (${task.cloudProgress || 0}%)`;
  if (isExtracting) statusText = 'Extracting';
  if (!isCompleted && !isExtracting && task.retryingCount > 0) statusText = 'Retrying';

  const typeIcon = task.type === 'torrent' ? ICONS.folder : task.type === 'folder' ? ICONS.folder : ICONS.link;

  let retryInfo = '';
  if (!isCompleted && task.retryingCount > 0 && task.nextRetryAt) {
    const secsLeft = Math.max(0, Math.ceil((task.nextRetryAt - Date.now()) / 1000));
    const fileWord = task.retryingCount === 1 ? 'file' : 'files';
    retryInfo = `<div class="metric-item text-warning">Retrying ${task.retryingCount} ${fileWord} in ${secsLeft}s</div>`;
  }

  const priorityLabels = { 0: 'High', 1: 'Normal', 2: 'Low' };
  const currentPriority = task.priority ?? 1;
  const priorityButtons = !isCompleted
    ? `
      <div class="priority-controls" title="Queue priority">
        ${[0, 1, 2].map((p) => `
          <button class="btn-priority ${currentPriority === p ? 'active' : ''}" onclick="setTaskPriority('${task.id}', ${p})" title="${priorityLabels[p]} priority">${priorityLabels[p]}</button>
        `).join('')}
      </div>
    `
    : '';

  const fileCount = task.files?.length || task.fileCount || 1;
  const errorText = task.error ? (task.error.length > 80 ? `${task.error.slice(0, 77)}…` : task.error) : '';

  return `
    <div class="task-card" data-task-id="${task.id}">
      <div class="task-header">
        <div class="task-title-area">
          <div class="task-type-badge">${typeIcon}</div>
          <div>
            <div class="task-name" title="${escapeHtml(task.name)}">${escapeHtml(task.name)}</div>
            <div class="task-meta-pills">
              <span class="telemetry-badge">${priorityLabels[currentPriority]} priority</span>
              <span class="telemetry-badge">${fileCount} ${fileCount === 1 ? 'file' : 'files'}</span>
              <span class="telemetry-badge">${formatBytes(task.downloadedSize)} of ${formatBytes(task.totalSize)}</span>
              ${task.autoExtract && !task.extracted && !isExtracting && !task.extractionError && !isCompleted ? `<span class="telemetry-badge badge-accent" title="Archives are extracted automatically when the download completes">Auto-extract</span>` : ''}
              ${isExtracting ? `<span class="telemetry-badge badge-warning">Extracting</span>` : ''}
              ${task.extracted ? `<span class="telemetry-badge badge-success">Extracted</span>` : ''}
              ${task.extractionError ? `<span class="telemetry-badge badge-danger" title="${escapeHtml(task.extractionError)}">Extraction failed</span>` : ''}
              ${task.error ? `<span class="telemetry-badge badge-danger" title="${escapeHtml(task.error)}">${escapeHtml(errorText)}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="status-pill ${task.status} ${task.retryingCount > 0 && !isCompleted ? 'retrying' : ''}">${statusText}</div>
      </div>

      <div class="task-progress-box">
        <div class="hpc-progress-track">
          <div class="hpc-progress-fill is-${task.status}" style="width: ${task.progress || 0}%;"></div>
        </div>
        <div class="task-metrics-row">
          <div class="metric-group">
            <div class="metric-item">
              <span class="metric-label">Progress</span>
              <span class="metric-val">${task.progress || 0}%</span>
            </div>
            ${isDownloading ? `
              <div class="metric-item">
                <span class="metric-label">Speed</span>
                <span class="metric-val">${formatSpeed(task.speed)}</span>
              </div>
            ` : ''}
            ${isDownloading && task.eta > 0 ? `
              <div class="metric-item">
                <span class="metric-label">ETA</span>
                <span class="metric-val">${formatEta(task.eta)}</span>
              </div>
            ` : ''}
            ${retryInfo}
            ${isExtracting ? `
              <div class="metric-item text-warning">Extracting archive files</div>
            ` : ''}
            ${isCompleted && !isExtracting ? `
              <div class="metric-item text-success">Verified on disk</div>
            ` : ''}
          </div>
        </div>
      </div>

      <div class="task-actions">
        ${priorityButtons}
        <button class="btn btn-secondary btn-sm" onclick="openFileTreeModal('${task.id}')" title="Inspect the file list">
          <span class="btn-svg">${ICONS.folder}</span>
          <span>Files</span>
        </button>

        ${isCompleted || task.downloadedSize > 0 ? `
          <button class="btn btn-secondary btn-sm" onclick="openLocalFolder('${task.id}')" title="Open the destination folder">
            <span class="btn-svg">${ICONS.drive}</span>
            <span>Open folder</span>
          </button>
        ` : ''}

        ${isCompleted && !task.extracted && !task.isExtracting ? `
          <button class="btn btn-secondary btn-sm" onclick="manualExtractTask('${task.id}')" title="Extract archives into the task folder without overwriting existing files">
            <span class="btn-svg">${ICONS.archive}</span>
            <span>Extract</span>
          </button>
        ` : ''}

        ${isDownloading ? `
          <button class="btn btn-secondary btn-sm" onclick="pauseTask('${task.id}')" title="Pause download">
            <span class="btn-svg">${ICONS.pause}</span>
            <span>Pause</span>
          </button>
        ` : ''}

        ${isPaused ? `
          <button class="btn btn-secondary btn-sm" onclick="resumeTask('${task.id}')" title="Resume download">
            <span class="btn-svg">${ICONS.play}</span>
            <span>Resume</span>
          </button>
        ` : ''}

        ${isError ? `
          <button class="btn btn-secondary btn-sm" onclick="retryTask('${task.id}')" title="Retry failed files">
            <span class="btn-svg">${ICONS.retry}</span>
            <span>Retry</span>
          </button>
        ` : ''}

        <button class="btn btn-danger btn-sm btn-icon" onclick="cancelTask('${task.id}')" title="Cancel and delete the task" aria-label="Cancel and delete the task">
          ${ICONS.trash}
        </button>
      </div>
    </div>
  `;
}

function sortCloudMagnets(list) {
  const mode = state.cloudSortMode;
  const sorted = [...list];
  if (mode === 'name') {
    sorted.sort((a, b) => String(a.filename || '').localeCompare(String(b.filename || ''), undefined, { sensitivity: 'base' }));
  } else if (mode === 'size') {
    sorted.sort((a, b) => (b.size || 0) - (a.size || 0));
  } else if (mode === 'age') {
    sorted.sort((a, b) => String(b.uploadDate || '').localeCompare(String(a.uploadDate || '')));
  }
  return sorted;
}

function updateCloudUsageBar() {
  const totalBytes = state.cloudMagnets.reduce((acc, m) => acc + (m.size || 0), 0);
  if (elements.cloudUsageText) {
    const magnetWord = state.cloudMagnets.length === 1 ? 'magnet' : 'magnets';
    elements.cloudUsageText.textContent = `${state.cloudMagnets.length} ${magnetWord}, ${formatBytes(totalBytes)} in cloud`;
  }
  const pct = Math.min(100, (totalBytes / (50 * 1024 ** 4)) * 100); // indicative scale vs 50 TB
  if (elements.cloudUsageBar) {
    elements.cloudUsageBar.style.width = `${Math.max(1, pct)}%`;
  }
}

function updateCloudBulkUi() {
  const count = state.cloudSelection.size;
  if (elements.cloudBulkDeleteBtn) {
    elements.cloudBulkDeleteBtn.style.display = count > 0 ? 'inline-flex' : 'none';
    elements.cloudBulkDeleteBtn.textContent = `Delete selected (${count})`;
  }
  if (elements.cloudSelectAllCheckbox) {
    elements.cloudSelectAllCheckbox.checked = state.cloudMagnets.length > 0 && count === state.cloudMagnets.length;
  }
}

function renderCloudMagnets() {
  const query = elements.cloudSearchInput.value.toLowerCase().trim();
  const filtered = sortCloudMagnets(
    state.cloudMagnets.filter((m) => !query || (m.filename && m.filename.toLowerCase().includes(query)))
  );

  elements.cloudCount.textContent = state.cloudMagnets.length;
  updateCloudUsageBar();
  updateCloudBulkUi();

  // Drop stale selections
  for (const id of [...state.cloudSelection]) {
    if (!state.cloudMagnets.some((m) => m.id === id)) state.cloudSelection.delete(id);
  }

  if (filtered.length === 0) {
    elements.cloudTorrentsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon-box">${ICONS.cloud}</div>
        <h2>No cloud torrents</h2>
        <p>Torrents saved or cached on your AllDebrid account appear here.</p>
      </div>
    `;
    return;
  }

  elements.cloudTorrentsList.innerHTML = filtered
    .map((m) => {
      const isReady = m.statusCode === 4 || m.status === 'Ready';
      const progress = isReady ? 100 : (m.size > 0 && typeof m.downloaded === 'number') ? Math.round((m.downloaded / m.size) * 100) : 0;
      const encodedName = encodeURIComponent(m.filename || '');
      const isSelected = state.cloudSelection.has(m.id);
      const statusLabel = isReady ? 'Ready' : `${m.status || 'Active'} (${progress}%)`;
      const seedWord = m.seeders === 1 ? 'seed' : 'seeds';

      return `
        <div class="cloud-card ${isSelected ? 'selected' : ''}">
          <label class="cloud-select-box">
            <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="toggleCloudSelect(${m.id})" aria-label="Select torrent" />
          </label>
          <div class="cloud-info">
            <div class="cloud-title" title="${m.filename || 'Torrent ' + m.id}">${m.filename || 'Torrent ' + m.id}</div>
            <div class="cloud-meta">
              <span>${formatBytes(m.size)}</span>
              <span>${statusLabel}</span>
              ${m.seeders !== undefined ? `<span>${m.seeders} ${seedWord}</span>` : ''}
              ${m.downloadSpeed > 0 ? `<span>${formatSpeed(m.downloadSpeed)}</span>` : ''}
            </div>
          </div>
          <div class="cloud-actions">
            <button class="btn btn-primary btn-sm" onclick="downloadCloudMagnet(${m.id}, decodeURIComponent('${encodedName}'))">
              <span class="btn-svg">${ICONS.drive}</span>
              <span>Download</span>
            </button>
            <button class="btn btn-danger btn-sm btn-icon" onclick="deleteCloudMagnet(${m.id})" title="Delete from cloud" aria-label="Delete from cloud">
              ${ICONS.trash}
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

window.toggleCloudSelect = function (id) {
  if (state.cloudSelection.has(id)) {
    state.cloudSelection.delete(id);
  } else {
    state.cloudSelection.add(id);
  }
  updateCloudBulkUi();
  renderCloudMagnets();
};

if (elements.cloudSelectAllCheckbox) {
  elements.cloudSelectAllCheckbox.onchange = () => {
    const query = elements.cloudSearchInput.value.toLowerCase().trim();
    const visible = state.cloudMagnets.filter((m) => !query || (m.filename && m.filename.toLowerCase().includes(query)));
    state.cloudSelection.clear();
    if (elements.cloudSelectAllCheckbox.checked) {
      visible.forEach((m) => state.cloudSelection.add(m.id));
    }
    renderCloudMagnets();
  };
}

if (elements.cloudSortSelect) {
  elements.cloudSortSelect.onchange = () => {
    state.cloudSortMode = elements.cloudSortSelect.value;
    renderCloudMagnets();
  };
}

// ============================================================
// Actions & Handlers
// ============================================================

window.openLocalFolder = async function (taskId) {
  try {
    const res = await apiFetch(`/api/downloads/${taskId}/open-folder`, { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    showToast('Opened destination directory in File Explorer', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.manualExtractTask = async function (taskId) {
  try {
    const res = await apiFetch(`/api/downloads/${taskId}/extract`, { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    showToast(data.result?.message || 'Extraction complete', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.pauseTask = async function (taskId) {
  await apiFetch(`/api/downloads/${taskId}/pause`, { method: 'POST' });
  showToast('Download stream paused', 'info');
};

window.resumeTask = async function (taskId) {
  await apiFetch(`/api/downloads/${taskId}/resume`, { method: 'POST' });
  showToast('Download stream resumed', 'info');
};

window.retryTask = async function (taskId) {
  await apiFetch(`/api/downloads/${taskId}/retry`, { method: 'POST' });
  showToast('Retrying failed streams...', 'info');
};

window.setTaskPriority = async function (taskId, priority) {
  try {
    const res = await apiFetch(`/api/downloads/${taskId}/priority`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const t = state.tasks.get(taskId);
    if (t) {
      t.priority = data.priority;
      renderTasks();
    }
    showToast(`Queue priority updated`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.cancelTask = async function (taskId) {
  if (confirm('Cancel and delete this task from pipeline?')) {
    await apiFetch(`/api/downloads/${taskId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteFiles: false }),
    });
    showToast('Task removed from pipeline', 'info');
  }
};

window.downloadCloudMagnet = async function (magnetId, name = '') {
  try {
    const res = await apiFetch(`/api/cloud-magnets/${magnetId}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    showToast('Queued cloud torrent into local download pipeline!', 'success');
    switchTab('active');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.deleteCloudMagnet = async function (magnetId) {
  if (confirm('Delete this torrent from your AllDebrid Cloud account?')) {
    try {
      const res = await apiFetch(`/api/cloud-magnets/${magnetId}/delete`, { method: 'POST' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      showToast('Deleted from AllDebrid cloud', 'success');
      fetchCloudMagnets();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }
};

if (elements.cloudBulkDeleteBtn) {
  elements.cloudBulkDeleteBtn.onclick = async () => {
    const ids = Array.from(state.cloudSelection);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} torrent(s) from your AllDebrid Cloud account? This cannot be undone.`)) return;

    elements.cloudBulkDeleteBtn.disabled = true;
    try {
      const res = await apiFetch('/api/cloud-magnets/delete-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      state.cloudSelection.clear();
      showToast(`Deleted ${data.deletedCount} cloud torrent(s)${data.failed?.length ? `, ${data.failed.length} failed` : ''}`, data.failed?.length ? 'info' : 'success');
      fetchCloudMagnets();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      elements.cloudBulkDeleteBtn.disabled = false;
      updateCloudBulkUi();
    }
  };
}

// ============================================================
// File Tree Viewer Modal
// ============================================================

window.openFileTreeModal = async function (taskId) {
  state.currentTreeTaskId = taskId;
  elements.fileTreeModal.classList.add('active');
  elements.treeContentArea.innerHTML = `
    <div class="shimmer-block">
      <div class="shimmer-line header"></div>
      <div class="shimmer-line sub"></div>
    </div>
  `;

  try {
    const res = await apiFetch(`/api/downloads/${taskId}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const task = data.task;
    elements.treeModalTitle.textContent = `${task.name}`;

    if (!task.files || task.files.length === 0) {
      elements.treeContentArea.innerHTML = `
        <div class="list-empty">Loading the file list…</div>
      `;
      return;
    }

    elements.treeContentArea.innerHTML = task.files
      .map((f) => {
        const isDone = f.status === 'completed';
        const isError = f.status === 'error';
        const iconSvg = getFileIconSvg(f.name);
        return `
          <div class="tree-row">
            <div class="tree-row-left">
              <span class="tree-row-icon">${iconSvg}</span>
              <span class="tree-path-text" title="${f.relativePath}">${f.relativePath}</span>
            </div>
            <div class="tree-row-right">
              <span>${formatBytes(f.size)}</span>
              <span class="status-pill ${f.status}">
                ${isDone ? 'Complete' : isError ? 'Error' : `${f.progress}%`}
              </span>
            </div>
          </div>
        `;
      })
      .join('');
  } catch (err) {
    elements.treeContentArea.innerHTML = `<p class="list-error">${err.message}</p>`;
  }
};

function closeFileTreeModal() {
  elements.fileTreeModal.classList.remove('active');
  state.currentTreeTaskId = null;
}

elements.closeTreeModalBtn.onclick = closeFileTreeModal;
elements.closeTreeModalBottomBtn.onclick = closeFileTreeModal;
elements.openLocalFolderFromTreeBtn.onclick = () => {
  if (state.currentTreeTaskId) {
    window.openLocalFolder(state.currentTreeTaskId);
  }
};

// ============================================================
// Modal & Tab Navigation
// ============================================================

function switchTab(tabId) {
  document.querySelectorAll('.nav-tab').forEach((tab) => {
    const isActive = tab.dataset.tab === tabId;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });

  document.querySelectorAll('.tab-content').forEach((pane) => {
    pane.classList.toggle('active', pane.id === `tab-${tabId}`);
  });

  state.activeTab = tabId;

  if (tabId === 'cloud') {
    fetchCloudMagnets();
  }
}

document.querySelectorAll('.nav-tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// Modal Tabs (Text vs File)
document.querySelectorAll('.modal-tab').forEach((tabBtn) => {
  tabBtn.addEventListener('click', () => {
    document.querySelectorAll('.modal-tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.modal-pane').forEach((p) => p.classList.remove('active'));

    tabBtn.classList.add('active');
    document.getElementById(`modal-tab-${tabBtn.dataset.modalTab}`).classList.add('active');
  });
});

// Add Modal Open / Close
elements.openAddModalBtn.onclick = () => {
  elements.addDownloadModal.classList.add('active');
  elements.downloadInputText.focus();
};

function closeAddModal() {
  elements.addDownloadModal.classList.remove('active');
  elements.downloadInputText.value = '';
  state.selectedTorrentFiles = [];
  elements.selectedFilesList.innerHTML = '';
  elements.submitUploadBtn.disabled = true;
}

elements.closeAddModalBtn.onclick = closeAddModal;
elements.cancelAddBtn.onclick = closeAddModal;
elements.cancelUploadBtn.onclick = closeAddModal;

// ============================================================
// Interactive Folder Browser Controller
// ============================================================

window.openFolderBrowser = function (initialPath = '', callback = null) {
  state.onFolderSelectedCallback = callback;
  elements.folderBrowserModal.classList.add('active');
  loadDirectory(initialPath || state.settings.downloadDir || '');
};

function closeFolderBrowser() {
  elements.folderBrowserModal.classList.remove('active');
  state.onFolderSelectedCallback = null;
}

elements.closeFolderBrowserBtn.onclick = closeFolderBrowser;
elements.cancelFolderBrowserBtn.onclick = closeFolderBrowser;

async function loadDirectory(targetPath = '') {
  elements.browserFoldersList.innerHTML = `
    <div class="shimmer-block" style="padding:12px;">
      <div class="shimmer-line" style="width:70%;"></div>
      <div class="shimmer-line" style="width:50%;"></div>
    </div>
  `;

  try {
    const url = targetPath ? `/api/browse-directory?path=${encodeURIComponent(targetPath)}` : '/api/browse-directory';
    const res = await apiFetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.browserCurrentPath = data.currentPath;
    state.browserParentPath = data.parentPath;
    elements.browserCurrentPathText.textContent = data.currentPath;
    elements.browserCurrentPathText.title = data.currentPath;

    // Up Button State
    elements.browserUpDirBtn.disabled = !data.parentPath;
    elements.browserUpDirBtn.style.opacity = data.parentPath ? '1' : '0.4';

    // Render Drive Buttons
    if (data.drives && data.drives.length > 0) {
      elements.browserDrivesBar.innerHTML = data.drives
        .map((d) => {
          const isActive = data.currentPath.toLowerCase().startsWith(d.toLowerCase());
          return `
            <button type="button" class="drive-btn ${isActive ? 'active' : ''}" onclick="loadDirectory('${d.replace(/\\/g, '\\\\')}')">
              <span class="btn-svg">${ICONS.drive}</span>
              <span>${d}</span>
            </button>
          `;
        })
        .join('');
    } else {
      elements.browserDrivesBar.innerHTML = '';
    }

    // Render Folders List
    if (!data.directories || data.directories.length === 0) {
      elements.browserFoldersList.innerHTML = `
        <div class="list-empty">No subfolders</div>
      `;
    } else {
      elements.browserFoldersList.innerHTML = data.directories
        .map(
          (d) => `
          <div class="folder-item" onclick="loadDirectory('${d.path.replace(/\\/g, '\\\\')}')">
            ${ICONS.folder}
            <span title="${d.name}">${d.name}</span>
          </div>
        `
        )
        .join('');
    }
  } catch (err) {
    elements.browserFoldersList.innerHTML = `
      <div class="list-error">Could not read this folder: ${err.message}</div>
    `;
  }
}

elements.browserUpDirBtn.onclick = () => {
  if (state.browserParentPath) {
    loadDirectory(state.browserParentPath);
  }
};

elements.createFolderBtn.onclick = async () => {
  const folderName = elements.newFolderNameInput.value.trim();
  if (!folderName) return;

  try {
    const res = await apiFetch('/api/create-directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentPath: state.browserCurrentPath,
        folderName,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    elements.newFolderNameInput.value = '';
    showToast(`Created folder "${folderName}"`, 'success');
    loadDirectory(data.path);
  } catch (err) {
    showToast(err.message, 'error');
  }
};

elements.selectFolderConfirmBtn.onclick = () => {
  const chosenPath = state.browserCurrentPath;
  if (!chosenPath) return;

  if (typeof state.onFolderSelectedCallback === 'function') {
    state.onFolderSelectedCallback(chosenPath);
  }

  closeFolderBrowser();
  showToast(`Selected destination: ${chosenPath}`, 'info');
};

elements.browseDownloadDirBtn.onclick = async () => {
  const currentDir = elements.downloadDirInput.value.trim();
  if (window.electronAPI && typeof window.electronAPI.selectFolder === 'function') {
    const selected = await window.electronAPI.selectFolder(currentDir);
    if (selected) {
      elements.downloadDirInput.value = selected;
      showToast(`Selected directory: ${selected}`, 'info');
    }
    return;
  }
  openFolderBrowser(currentDir, (selectedPath) => {
    elements.downloadDirInput.value = selectedPath;
  });
};

// ============================================================
// Download Review & Structure Verification Controller
// ============================================================

function openDownloadReview(previews) {
  if (!previews || previews.length === 0) return;

  state.reviewPreviews = previews;
  state.reviewSelectedPaths = new Set();

  const primaryItem = previews[0];
  elements.reviewTorrentName.textContent = primaryItem.name;
  elements.reviewTorrentName.title = primaryItem.name;
  elements.reviewTotalSize.textContent = formatBytes(primaryItem.totalSize);

  const fileCount = primaryItem.flattenedFiles?.length || 1;
  elements.reviewFileCount.textContent = `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;

  elements.reviewStatusBadge.textContent = primaryItem.isReady ? 'Ready' : 'Waiting for cloud';
  elements.reviewStatusBadge.className = `telemetry-badge ${primaryItem.isReady ? 'badge-success' : 'badge-warning'}`;

  elements.reviewOutputDirInput.value = primaryItem.defaultOutputDir;

  // Disk-space pre-flight warning
  const diskWarning = document.getElementById('reviewDiskWarning');
  if (diskWarning) {
    if (primaryItem.fitsOnDisk === false) {
      const freeStr = primaryItem.freeSpaceBytes != null ? formatBytes(primaryItem.freeSpaceBytes) : 'unknown';
      diskWarning.innerHTML = `Low disk space. This task needs <strong>${formatBytes(primaryItem.totalSize)}</strong> but only <strong>${freeStr}</strong> is free at the destination. Consider another drive.`;
      diskWarning.style.display = 'block';
    } else {
      diskWarning.style.display = 'none';
    }
  }

  if (elements.reviewAutoExtractCheckbox) {
    elements.reviewAutoExtractCheckbox.checked = false;
    elements.reviewAutoExtractCheckbox.disabled = false;
  }
  if (elements.reviewDeletePartsCheckbox) {
    elements.reviewDeletePartsCheckbox.checked = false;
    elements.reviewDeletePartsCheckbox.disabled = true;
  }

  // Initialize selected files (skip already complete files by default if desired or include uncompleted)
  if (primaryItem.flattenedFiles) {
    primaryItem.flattenedFiles.forEach((f) => {
      // If not fully completed, select by default
      if (!f.isCompleteOnDisk) {
        state.reviewSelectedPaths.add(f.relativePath);
      }
    });
    // If all files were complete, select all so user has full control
    if (state.reviewSelectedPaths.size === 0) {
      primaryItem.flattenedFiles.forEach((f) => state.reviewSelectedPaths.add(f.relativePath));
    }
  }

  renderReviewTree();
  elements.downloadReviewModal.classList.add('active');
}

function closeDownloadReview() {
  elements.downloadReviewModal.classList.remove('active');
  state.reviewPreviews = [];
  state.reviewSelectedPaths.clear();
}

elements.closeReviewModalBtn.onclick = closeDownloadReview;
elements.cancelReviewBtn.onclick = () => {
  closeDownloadReview();
  elements.addDownloadModal.classList.add('active');
};

elements.changeReviewDirBtn.onclick = async () => {
  const currentDir = elements.reviewOutputDirInput.value.trim();
  if (window.electronAPI && typeof window.electronAPI.selectFolder === 'function') {
    const selected = await window.electronAPI.selectFolder(currentDir);
    if (selected) {
      elements.reviewOutputDirInput.value = selected;
      showToast(`Selected directory: ${selected}`, 'info');
    }
    return;
  }
  openFolderBrowser(currentDir, (selectedPath) => {
    elements.reviewOutputDirInput.value = selectedPath;
  });
};

function renderReviewTree() {
  const primaryItem = state.reviewPreviews[0];
  if (!primaryItem) return;

  const files = primaryItem.flattenedFiles || [];
  elements.reviewSelectedCount.textContent = state.reviewSelectedPaths.size;

  if (files.length === 0) {
    elements.reviewTreeContainer.innerHTML = `
      <div class="list-empty">The file list is still being prepared. It appears here when the cloud copy is ready.</div>
    `;
    return;
  }

  elements.reviewTreeContainer.innerHTML = files
    .map((f) => {
      const isChecked = state.reviewSelectedPaths.has(f.relativePath);
      const iconSvg = getFileIconSvg(f.name);
      
      let diskBadge = '';
      if (f.isCompleteOnDisk) {
        diskBadge = '<span class="status-pill completed">On disk</span>';
      } else if (f.existsOnDisk && f.diskBytes > 0) {
        diskBadge = `<span class="status-pill downloading">Resume from ${formatBytes(f.diskBytes)}</span>`;
      }

      return `
        <label class="tree-row">
          <div class="tree-row-left">
            <input type="checkbox" data-path="${f.relativePath}" ${isChecked ? 'checked' : ''} onchange="toggleReviewFile('${f.relativePath}')" />
            <span class="tree-row-icon">${iconSvg}</span>
            <span class="tree-path-text" title="${f.relativePath}">${f.relativePath}</span>
          </div>
          <div class="tree-row-right">
            ${diskBadge}
            <span>${formatBytes(f.size)}</span>
          </div>
        </label>
      `;
    })
    .join('');
}

window.toggleReviewFile = function (relativePath) {
  if (state.reviewSelectedPaths.has(relativePath)) {
    state.reviewSelectedPaths.delete(relativePath);
  } else {
    state.reviewSelectedPaths.add(relativePath);
  }
  elements.reviewSelectedCount.textContent = state.reviewSelectedPaths.size;
};

elements.selectAllReviewFilesBtn.onclick = () => {
  const primaryItem = state.reviewPreviews[0];
  if (primaryItem && primaryItem.flattenedFiles) {
    primaryItem.flattenedFiles.forEach((f) => state.reviewSelectedPaths.add(f.relativePath));
    renderReviewTree();
  }
};

elements.deselectAllReviewFilesBtn.onclick = () => {
  state.reviewSelectedPaths.clear();
  renderReviewTree();
};

if (elements.reviewAutoExtractCheckbox) {
  elements.reviewAutoExtractCheckbox.onchange = () => {
    if (!elements.reviewDeletePartsCheckbox) return;
    if (!elements.reviewAutoExtractCheckbox.checked) {
      elements.reviewDeletePartsCheckbox.checked = false;
    }
    elements.reviewDeletePartsCheckbox.disabled = !elements.reviewAutoExtractCheckbox.checked;
  };
}

// Confirm & Launch Download from Review Screen
elements.confirmReviewDownloadBtn.onclick = async () => {
  if (state.reviewPreviews.length === 0) return;

  const chosenOutputDir = elements.reviewOutputDirInput.value.trim();
  const selectedList = Array.from(state.reviewSelectedPaths);

  if (selectedList.length === 0 && state.reviewPreviews[0].flattenedFiles?.length > 0) {
    showToast('Select at least one file to download', 'error');
    return;
  }

  const autoExtract = !!elements.reviewAutoExtractCheckbox?.checked;
  const deleteArchiveAfterExtract = autoExtract && !!elements.reviewDeletePartsCheckbox?.checked;

  elements.confirmReviewDownloadBtn.disabled = true;
  elements.confirmReviewDownloadBtn.textContent = 'Starting…';

  const itemsPayload = state.reviewPreviews.map((p) => ({
    planId: p.planId || undefined,
    type: p.type,
    magnetId: p.magnetId,
    url: p.url,
    name: p.name,
    filesTree: p.planId ? undefined : p.filesTree,
    files: p.planId ? undefined : p.flattenedFiles,
    customOutputDir: chosenOutputDir,
    selectedFiles: selectedList.length > 0 ? selectedList : null,
    autoExtract,
    deleteArchiveAfterExtract,
  }));

  try {
    const res = await apiFetch('/api/downloads/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: itemsPayload }),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (data.addedCount === 0 && data.errors?.length > 0) {
      throw new Error(data.errors.join('; '));
    }

    showToast(`Added ${data.addedCount} download${data.addedCount === 1 ? '' : 's'}`, 'success');
    closeDownloadReview();
    closeAddModal();
    switchTab('active');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    elements.confirmReviewDownloadBtn.disabled = false;
    elements.confirmReviewDownloadBtn.innerHTML = `
      <svg class="btn-svg" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
      <span>Start download</span>
    `;
  }
};

// ============================================================
// Add Download Modal Handlers
// ============================================================

// Submit Text Links -> Trigger Preview
elements.submitAddBtn.onclick = async () => {
  const input = elements.downloadInputText.value.trim();
  if (!input) {
    showToast('Please enter a link, magnet, or getMagnet URL', 'error');
    return;
  }

  elements.submitAddBtn.disabled = true;
  elements.submitAddBtn.textContent = 'Reading files…';

  try {
    const res = await apiFetch('/api/downloads/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!data.previews || data.previews.length === 0) {
      throw new Error(data.errors?.[0] || 'No downloadable torrent structure found');
    }

    elements.addDownloadModal.classList.remove('active');
    openDownloadReview(data.previews);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    elements.submitAddBtn.disabled = false;
    elements.submitAddBtn.textContent = 'Review files';
  }
};

// Drag & Drop .torrent Upload
elements.torrentDropzone.onclick = () => elements.torrentFileInput.click();

elements.torrentDropzone.ondragover = (e) => {
  e.preventDefault();
  elements.torrentDropzone.classList.add('dragover');
};

elements.torrentDropzone.ondragleave = () => {
  elements.torrentDropzone.classList.remove('dragover');
};

elements.torrentDropzone.ondrop = (e) => {
  e.preventDefault();
  elements.torrentDropzone.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
};

elements.torrentFileInput.onchange = (e) => {
  handleFiles(e.target.files);
};

function handleFiles(fileList) {
  const torrents = Array.from(fileList).filter((f) => f.name.endsWith('.torrent'));
  if (torrents.length === 0) {
    showToast('Only .torrent files are supported here', 'error');
    return;
  }

  state.selectedTorrentFiles = torrents;
  elements.selectedFilesList.innerHTML = torrents
    .map(
      (f) => `
      <div class="tree-row" style="margin-top:4px;">
        <div class="tree-row-left">
          <span class="tree-row-icon">${ICONS.document}</span>
          <span class="tree-path-text">${f.name}</span>
        </div>
        <div class="tree-row-right">
          <span>${formatBytes(f.size)}</span>
        </div>
      </div>
    `
    )
    .join('');

  elements.submitUploadBtn.disabled = false;
}

// Submit Upload .torrent -> Trigger Preview
elements.submitUploadBtn.onclick = async () => {
  if (state.selectedTorrentFiles.length === 0) return;

  const formData = new FormData();
  state.selectedTorrentFiles.forEach((file) => {
    formData.append('torrents', file);
  });

  elements.submitUploadBtn.disabled = true;
  elements.submitUploadBtn.textContent = 'Reading torrent…';

  try {
    const res = await apiFetch('/api/downloads/preview', {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!data.previews || data.previews.length === 0) {
      throw new Error(data.errors?.[0] || 'No torrent structure found');
    }

    elements.addDownloadModal.classList.remove('active');
    openDownloadReview(data.previews);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    elements.submitUploadBtn.disabled = false;
    elements.submitUploadBtn.textContent = 'Review files';
  }
};

// ============================================================
// Settings Management
// ============================================================

elements.maxConcurrentRange.oninput = () => {
  elements.maxConcurrentVal.textContent = `${elements.maxConcurrentRange.value} workers`;
};

elements.toggleApiKeyVisibility.onclick = () => {
  const isPw = elements.apiKeyInput.type === 'password';
  elements.apiKeyInput.type = isPw ? 'text' : 'password';
};

elements.settingsForm.onsubmit = async (e) => {
  e.preventDefault();

  const payload = {
    newApiKey: elements.apiKeyInput.value.trim(),
    newDownloadDir: elements.downloadDirInput.value.trim(),
    newMaxConcurrent: parseInt(elements.maxConcurrentRange.value, 10),
    newJackettUrl: elements.jackettUrlInput ? elements.jackettUrlInput.value.trim() : '',
    newJackettApiKey: elements.jackettApiKeyInput ? elements.jackettApiKeyInput.value.trim() : '',
    newSpeedLimitKbps: parseInt(elements.speedLimitInput?.value, 10) || 0,
    newMaxRetries: parseInt(elements.maxRetriesInput?.value, 10) || 0,
    newMinFreeGb: parseFloat(elements.minFreeGbInput?.value) || 0,
    newScheduleEnabled: elements.scheduleEnabledCheckbox?.checked || false,
    newScheduleStart: elements.scheduleStartInput?.value.trim() || '',
    newScheduleEnd: elements.scheduleEndInput?.value.trim() || '',
    newScheduleLimitKbps: parseInt(elements.scheduleLimitInput?.value, 10) || 0,
  };

  const newToken = elements.authTokenInput?.value.trim();
  if (newToken) {
    payload.newAuthToken = newToken;
  }

  try {
    const res = await apiFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error);

    if (newToken) {
      storeToken(newToken);
      if (elements.authTokenInput) elements.authTokenInput.value = '';
      showToast('Access token saved. Keep it safe, it is required for all API access.', 'success');
    } else {
      showToast('Settings saved', 'success');
    }
    fetchStatus();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

function syncScheduleFieldsState() {
  const enabled = elements.scheduleEnabledCheckbox?.checked;
  for (const el of [elements.scheduleStartInput, elements.scheduleEndInput, elements.scheduleLimitInput]) {
    if (el) {
      el.disabled = !enabled;
      el.style.opacity = enabled ? '1' : '0.4';
    }
  }
}

if (elements.scheduleEnabledCheckbox) {
  elements.scheduleEnabledCheckbox.onchange = syncScheduleFieldsState;
}

elements.testApiBtn.onclick = async () => {
  elements.testApiBtn.disabled = true;
  elements.testApiBtn.textContent = 'Checking…';

  try {
    // If user entered a key in input, save it first
    if (elements.apiKeyInput.value.trim()) {
      await apiFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newApiKey: elements.apiKeyInput.value.trim() }),
      });
    }

    const res = await apiFetch('/api/status');
    const data = await res.json();

    if (data.userInfo) {
      const tier = data.userInfo.isPremium ? 'premium' : 'expired';
      showToast(`Connected as ${data.userInfo.username} (${tier} account)`, 'success');
    } else {
      showToast(`Could not verify credentials: ${data.userError || 'invalid API key'}`, 'error');
    }
    fetchStatus();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    elements.testApiBtn.disabled = false;
    elements.testApiBtn.textContent = 'Test connection';
  }
};

// ============================================================
// Release Discovery & Torrent Search Controller
// ============================================================

async function performSearch() {
  const query = elements.torrentSearchInput.value.trim();
  if (!query) {
    elements.searchResultsContainer.innerHTML = `
      <div class="empty-state">
        <svg class="empty-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <div class="empty-title">Search releases</div>
        <div class="empty-desc">Enter a title to search the indexers and check AllDebrid cache availability before downloading.</div>
      </div>
    `;
    elements.searchMetaBar.style.display = 'none';
    return;
  }

  state.isSearching = true;
  state.searchQuery = query;
  elements.searchSkeleton.style.display = 'flex';
  elements.searchResultsContainer.innerHTML = '';
  elements.searchMetaBar.style.display = 'none';
  elements.triggerSearchBtn.disabled = true;
  elements.triggerSearchBtn.textContent = 'Searching…';

  const category = state.searchCategory || 'all';
  const onlyCached = elements.onlyCachedCheckbox?.checked || false;

  try {
    const url = `/api/search?q=${encodeURIComponent(query)}&category=${encodeURIComponent(category)}&onlyCached=${onlyCached}`;
    const res = await apiFetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.searchResults = data.results || [];
    renderSearchResults(state.searchResults);

    // Update Meta & Badge
    elements.searchMetaBar.style.display = 'flex';
    elements.searchResultTotal.textContent = data.total || 0;
    elements.searchResultInstant.textContent = data.instantCount || 0;

    if (data.instantCount > 0) {
      elements.searchInstantBadge.style.display = 'inline-flex';
      elements.searchInstantBadge.textContent = `${data.instantCount} cached`;
    } else {
      elements.searchInstantBadge.style.display = 'none';
    }
  } catch (err) {
    elements.searchResultsContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-title text-danger">Search failed</div>
        <div class="empty-desc">${err.message}</div>
      </div>
    `;
  } finally {
    state.isSearching = false;
    elements.searchSkeleton.style.display = 'none';
    elements.triggerSearchBtn.disabled = false;
    elements.triggerSearchBtn.innerHTML = `
      <svg class="btn-svg" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <span>Search</span>
    `;
  }
}

function renderSearchResults(results) {
  if (!results || results.length === 0) {
    elements.searchResultsContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">No releases found</div>
        <div class="empty-desc">Try a different title, or turn off the cached-only filter.</div>
      </div>
    `;
    return;
  }

  elements.searchResultsContainer.innerHTML = results
    .map((r) => {
      const isInstant = r.instant === true || r.alldebridReady === true;
      const sizeStr = r.sizeStr || formatBytes(r.size);
      const encodedMagnet = encodeURIComponent(r.magnet || '');
      const encodedTitle = encodeURIComponent(r.title || '');

      const posterImg = r.poster
        ? `<img class="search-card-thumb" src="${r.poster}" alt="" loading="lazy" onerror="this.style.display='none'" />`
        : `<div class="search-card-icon">${ICONS.video}</div>`;

      const seedWord = r.seeders === 1 ? 'seed' : 'seeds';
      const peerWord = r.leechers === 1 ? 'peer' : 'peers';

      return `
        <div class="search-result-card ${isInstant ? 'is-instant' : ''}">
          <div class="search-card-main">
            ${posterImg}
            <div class="search-card-info">
              <div class="search-card-title" title="${r.title}">${r.title}</div>
              <div class="search-card-meta">
                ${isInstant ? `<span class="badge-instant-cached">Cached</span>` : `<span class="badge-p2p-needed">Seeding required</span>`}
                <span class="category-tag">${r.category || 'General'}</span>
                <span class="indexer-badge">${r.indexer || 'Torrent'}</span>
                <span class="telemetry-badge">${sizeStr}</span>
                <span class="telemetry-badge">${r.seeders || 0} ${seedWord}</span>
                <span class="telemetry-badge">${r.leechers || 0} ${peerWord}</span>
                ${r.year ? `<span class="telemetry-badge">${r.year}</span>` : ''}
              </div>
            </div>
          </div>

          <div class="search-card-actions">
            <button class="btn btn-primary btn-sm" onclick="dispatchSearchDownload(decodeURIComponent('${encodedMagnet}'), decodeURIComponent('${encodedTitle}'))" title="Download directly to disk">
              <svg class="btn-svg" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span>Download</span>
            </button>

            <button class="btn btn-secondary btn-sm" onclick="saveSearchToCloud(decodeURIComponent('${encodedMagnet}'), decodeURIComponent('${encodedTitle}'))" title="Save to AllDebrid cloud">
              <span class="btn-svg">${ICONS.cloud}</span>
              <span>Cloud</span>
            </button>

            <button class="btn btn-secondary btn-sm btn-icon" onclick="copyMagnetLink(decodeURIComponent('${encodedMagnet}'))" title="Copy magnet link" aria-label="Copy magnet link">
              <span class="btn-svg">${ICONS.link}</span>
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

window.dispatchSearchDownload = async function (magnetUri, title) {
  if (!magnetUri) {
    showToast('No magnet URI available for this release', 'error');
    return;
  }

  showToast(`Inspecting topology for "${title || 'Release'}"...`, 'info');

  try {
    const res = await apiFetch('/api/downloads/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: magnetUri }),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!data.previews || data.previews.length === 0) {
      throw new Error(data.errors?.[0] || 'Unable to resolve magnet structure');
    }

    openDownloadReview(data.previews);
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.saveSearchToCloud = async function (magnetUri, title) {
  if (!magnetUri) return;
  try {
    const res = await apiFetch('/api/downloads/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: magnetUri }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    showToast(`Saved "${title || 'Release'}" to AllDebrid Cloud cache!`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.copyMagnetLink = async function (magnetUri) {
  if (!magnetUri) return;
  try {
    await navigator.clipboard.writeText(magnetUri);
    showToast('Magnet link copied to clipboard!', 'success');
  } catch {
    showToast('Failed to copy magnet link', 'error');
  }
};

// Search listeners
if (elements.triggerSearchBtn) {
  elements.triggerSearchBtn.onclick = performSearch;
}

if (elements.torrentSearchInput) {
  elements.torrentSearchInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      performSearch();
    }
  };
}

if (elements.onlyCachedCheckbox) {
  elements.onlyCachedCheckbox.onchange = performSearch;
}

// Category pills
if (elements.searchCategoryPills) {
  elements.searchCategoryPills.querySelectorAll('.cat-pill').forEach((btn) => {
    btn.onclick = () => {
      elements.searchCategoryPills.querySelectorAll('.cat-pill').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.searchCategory = btn.dataset.cat;
      if (elements.torrentSearchInput.value.trim()) {
        performSearch();
      }
    };
  });
}

// ============================================================
// Batch Cache Checker Controller
// ============================================================

function openBatchCacheModal() {
  elements.batchCacheModal.classList.add('active');
  elements.batchCacheTextarea.focus();
}

function closeBatchCacheModal() {
  elements.batchCacheModal.classList.remove('active');
}

if (elements.openBatchCacheModalBtn) {
  elements.openBatchCacheModalBtn.onclick = openBatchCacheModal;
}
if (elements.closeBatchCacheModalBtn) {
  elements.closeBatchCacheModalBtn.onclick = closeBatchCacheModal;
}
if (elements.closeBatchCacheModalBottomBtn) {
  elements.closeBatchCacheModalBottomBtn.onclick = closeBatchCacheModal;
}

if (elements.runBatchCacheCheckBtn) {
  elements.runBatchCacheCheckBtn.onclick = async () => {
    const text = elements.batchCacheTextarea.value.trim();
    if (!text) {
      showToast('Paste at least one magnet URI or 40-char hash', 'error');
      return;
    }

    elements.runBatchCacheCheckBtn.disabled = true;
    elements.runBatchCacheCheckBtn.textContent = 'Checking…';

    try {
      const res = await apiFetch('/api/magnet/check-cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnets: text }),
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const list = data.results || [];
      elements.batchCacheSummaryText.innerHTML = `Found <strong class="text-strong">${list.length}</strong> items, <strong class="text-success">${data.instantCount || 0}</strong> ready instantly.`;

      if (list.length === 0) {
        elements.batchCacheTbody.innerHTML = `<tr><td colspan="4" class="cell-empty">No valid magnets found.</td></tr>`;
      } else {
        elements.batchCacheTbody.innerHTML = list
          .map((item) => {
            const isReady = item.ready === true;
            const statusBadge = isReady
              ? `<span class="badge-instant-cached">Cached</span>`
              : `<span class="badge-p2p-needed">Seeding</span>`;
            const sizeText = item.size ? formatBytes(item.size) : 'Unknown';
            const nameText = item.name || item.hash || item.magnet || 'Unknown';
            const encodedMag = encodeURIComponent(item.magnet || item.hash || '');
            const encodedName = encodeURIComponent(item.name || '');

            return `
              <tr>
                <td>${statusBadge}</td>
                <td class="mono cell-name" title="${nameText}">${nameText}</td>
                <td class="mono">${sizeText}</td>
                <td class="cell-action">
                  <button class="btn btn-primary btn-sm" onclick="dispatchSearchDownload(decodeURIComponent('${encodedMag}'), decodeURIComponent('${encodedName}')); closeBatchCacheModal();">
                    <span>Download</span>
                  </button>
                </td>
              </tr>
            `;
          })
          .join('');
      }

      elements.batchCacheResultsContainer.style.display = 'block';
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      elements.runBatchCacheCheckBtn.disabled = false;
      elements.runBatchCacheCheckBtn.innerHTML = `
        <svg class="btn-svg" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
        <span>Check availability</span>
      `;
    }
  };
}

// Search Filter Listeners
elements.activeSearchInput.oninput = renderTasks;
elements.completedSearchInput.oninput = renderTasks;
elements.cloudSearchInput.oninput = renderCloudMagnets;
elements.refreshCloudBtn.onclick = fetchCloudMagnets;

// Initial Bootstrap: verify access gate before hitting protected APIs
(async function bootstrap() {
  try {
    const res = await fetch('/api/auth-check', {
      headers: getStoredToken() ? { Authorization: `Bearer ${getStoredToken()}` } : {},
    });
    const data = await res.json();
    if (data.authRequired && !data.tokenValid) {
      showTokenModal();
      return;
    }
  } catch {}
  connectWebSocket();
  fetchStatus();
})();
