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
  testApiBtn: document.getElementById('testApiBtn'),
  // Toast
  toastContainer: document.getElementById('toastContainer'),
};

// ============================================================
// SVG Icon System (No Emojis per design.md)
// ============================================================

const ICONS = {
  video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>`,
  audio: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`,
  document: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
  image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  cloud: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`,
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`,
  alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
  play: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  retry: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  drive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/></svg>`,
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
  toast.innerHTML = `<div class="toast-icon">${iconSvg}</div><span class="mono">${message}</span>`;
  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.25s ease-out';
    setTimeout(() => toast.remove(), 260);
  }, 4200);
}

// ============================================================
// WebSocket Connection & Real-Time Sync
// ============================================================

let ws = null;
let reconnectTimer = null;

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    elements.wsStatus.innerHTML = '<span class="pulse-dot"></span><span class="socket-text mono">SOCKET LIVE</span>';
    elements.wsStatus.style.color = 'var(--accent-success)';
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
    elements.wsStatus.innerHTML = '<span class="pulse-dot" style="background:var(--accent-primary);box-shadow:0 0 8px var(--accent-primary);"></span><span class="socket-text mono">OFFLINE</span>';
    elements.wsStatus.style.color = 'var(--accent-primary)';
    reconnectTimer = setTimeout(connectWebSocket, 2500);
  };

  ws.onerror = () => {
    ws.close();
  };
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
  }
}

// ============================================================
// API Calls & Account Status
// ============================================================

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    state.settings.hasApiKey = data.hasApiKey;
    state.settings.downloadDir = data.downloadDir;
    state.settings.maxConcurrent = data.maxConcurrent;

    if (data.userInfo) {
      const u = data.userInfo;
      const isPrem = u.isPremium;
      elements.userStatusLabel.textContent = isPrem ? 'PREMIUM NODE' : 'STANDARD NODE';
      elements.userStatusValue.textContent = `${u.username || 'User'}`;
      elements.userPill.style.borderColor = isPrem ? 'rgba(0, 255, 102, 0.4)' : 'rgba(255, 176, 32, 0.4)';
    } else if (data.hasApiKey && data.userError) {
      elements.userStatusLabel.textContent = 'NODE ERROR';
      elements.userStatusValue.textContent = 'AUTH FAILED';
      elements.userPill.style.borderColor = 'rgba(237, 28, 36, 0.4)';
    } else {
      elements.userStatusLabel.textContent = 'API CREDENTIAL';
      elements.userStatusValue.textContent = 'NOT CONFIGURED';
      elements.userPill.style.borderColor = 'rgba(255, 176, 32, 0.4)';
    }

    // Populate settings form
    elements.downloadDirInput.value = data.downloadDir || '';
    elements.maxConcurrentRange.value = data.maxConcurrent || 3;
    elements.maxConcurrentVal.textContent = `${data.maxConcurrent || 3} WORKERS`;
  } catch (err) {
    console.error('Failed to fetch status:', err);
  }
}

async function fetchCloudMagnets() {
  elements.cloudTorrentsList.innerHTML = `
    <div class="shimmer-card">
      <div class="shimmer-line header"></div>
      <div class="shimmer-line sub"></div>
      <div class="shimmer-line bar"></div>
    </div>
  `;

  try {
    const res = await fetch('/api/cloud-magnets');
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.cloudMagnets = data.magnets || [];
    renderCloudMagnets();
  } catch (err) {
    elements.cloudTorrentsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon-box" style="color:var(--accent-primary);">
          ${ICONS.alert}
        </div>
        <h3>CLOUD SYNC FAILED</h3>
        <p>${err.message}</p>
        <button class="btn btn-secondary" onclick="fetchCloudMagnets()">RETRY QUERY</button>
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
  elements.activeStatsText.textContent = `${activeCount} TASKS IN PIPELINE`;
  elements.completedStatsText.textContent = `${completedCount} COMPLETED JOBS`;
}

function renderTasks() {
  const activeQuery = elements.activeSearchInput.value.toLowerCase().trim();
  const completedQuery = elements.completedSearchInput.value.toLowerCase().trim();

  const allTasks = Array.from(state.tasks.values());
  const activeTasks = allTasks.filter((t) => t.status !== 'completed' && (!activeQuery || t.name.toLowerCase().includes(activeQuery)));
  const completedTasks = allTasks.filter((t) => t.status === 'completed' && (!completedQuery || t.name.toLowerCase().includes(completedQuery)));

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

  let statusText = task.status.toUpperCase().replace(/_/g, ' ');
  if (isWaitingCloud) statusText = `CLOUD SYNC (${task.cloudProgress || 0}%)`;

  const typeIcon = task.type === 'torrent' ? ICONS.folder : ICONS.link;

  return `
    <div class="task-card" data-task-id="${task.id}">
      <div class="task-header">
        <div class="task-title-area">
          <div class="task-type-badge">${typeIcon}</div>
          <div>
            <div class="task-name" title="${task.name}">${task.name}</div>
            <div class="task-meta-pills" style="margin-top: 6px;">
              <span class="telemetry-badge">${task.files?.length || 1} FILES PRESERVED</span>
              <span class="telemetry-badge">${formatBytes(task.downloadedSize)} / ${formatBytes(task.totalSize)}</span>
              ${task.error ? `<span class="telemetry-badge" style="color:var(--accent-primary);border-color:rgba(237,28,36,0.4)">${task.error}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="status-pill ${task.status}">
          [ ${statusText} ]
        </div>
      </div>

      <div class="task-progress-box">
        <div class="hpc-progress-track">
          <div class="hpc-progress-fill ${isDownloading ? 'active-stream' : ''}" 
               style="width: ${task.progress || 0}%;"></div>
        </div>
        <div class="task-metrics-row">
          <div class="metric-group">
            <div class="metric-item">
              <span class="metric-label">PROGRESS:</span>
              <span class="metric-val highlight">${task.progress || 0}%</span>
            </div>
            ${isDownloading ? `
              <div class="metric-item">
                <span class="metric-label">SPEED:</span>
                <span class="metric-val highlight">${formatSpeed(task.speed)}</span>
              </div>
            ` : ''}
            ${isDownloading && task.eta > 0 ? `
              <div class="metric-item">
                <span class="metric-label">ETA:</span>
                <span class="metric-val">${formatEta(task.eta)}</span>
              </div>
            ` : ''}
            ${isCompleted ? `
              <div class="metric-item" style="color:var(--accent-success)">
                ✓ ON-DISK VERIFIED
              </div>
            ` : ''}
          </div>
        </div>
      </div>

      <div class="task-actions">
        <button class="btn btn-secondary btn-sm" onclick="openFileTreeModal('${task.id}')" title="Inspect file hierarchy">
          <span class="btn-svg">${ICONS.folder}</span>
          <span>STRUCTURE</span>
        </button>
        
        ${isCompleted || task.downloadedSize > 0 ? `
          <button class="btn btn-secondary btn-sm" onclick="openLocalFolder('${task.id}')" title="Open directory in File Explorer">
            <span class="btn-svg">${ICONS.drive}</span>
            <span>OPEN FOLDER</span>
          </button>
        ` : ''}

        ${isDownloading ? `
          <button class="btn btn-secondary btn-sm" onclick="pauseTask('${task.id}')" title="Pause Download">
            <span class="btn-svg">${ICONS.pause}</span>
            <span>PAUSE</span>
          </button>
        ` : ''}

        ${isPaused ? `
          <button class="btn btn-secondary btn-sm" onclick="resumeTask('${task.id}')" title="Resume Download">
            <span class="btn-svg">${ICONS.play}</span>
            <span>RESUME</span>
          </button>
        ` : ''}

        ${isError ? `
          <button class="btn btn-secondary btn-sm" onclick="retryTask('${task.id}')" title="Retry Download">
            <span class="btn-svg">${ICONS.retry}</span>
            <span>RETRY</span>
          </button>
        ` : ''}

        <button class="btn btn-danger btn-sm btn-icon" onclick="cancelTask('${task.id}')" title="Cancel & Delete">
          ${ICONS.trash}
        </button>
      </div>
    </div>
  `;
}

function renderCloudMagnets() {
  const query = elements.cloudSearchInput.value.toLowerCase().trim();
  const filtered = state.cloudMagnets.filter((m) => !query || (m.filename && m.filename.toLowerCase().includes(query)));

  elements.cloudCount.textContent = state.cloudMagnets.length;

  if (filtered.length === 0) {
    elements.cloudTorrentsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon-box">${ICONS.cloud}</div>
        <h3>NO CLOUD STORAGE MAGNETS</h3>
        <p>Torrents uploaded or cached on your AllDebrid account will display here.</p>
      </div>
    `;
    return;
  }

  elements.cloudTorrentsList.innerHTML = filtered
    .map((m) => {
      const isReady = m.statusCode === 4 || m.status === 'Ready';
      const isDownloading = m.statusCode === 1 || m.status === 'Downloading';
      const progress = isReady ? 100 : (m.size > 0 && typeof m.downloaded === 'number') ? Math.round((m.downloaded / m.size) * 100) : 0;
      const encodedName = encodeURIComponent(m.filename || '');

      return `
        <div class="cloud-card">
          <div class="cloud-info">
            <div class="cloud-title mono" title="${m.filename || 'Torrent ' + m.id}">${m.filename || 'Torrent #' + m.id}</div>
            <div class="cloud-meta">
              <span>${formatBytes(m.size)}</span>
              <span>•</span>
              <span style="color:var(--accent-electric);">${m.status || 'Active'} (${progress}%)</span>
              ${m.seeders !== undefined ? `<span>• ${m.seeders} SEEDS</span>` : ''}
              ${m.downloadSpeed > 0 ? `<span>• ${formatSpeed(m.downloadSpeed)}</span>` : ''}
            </div>
          </div>
          <div class="cloud-actions">
            <button class="btn btn-primary btn-sm" onclick="downloadCloudMagnet(${m.id}, decodeURIComponent('${encodedName}'))">
              <span class="btn-svg">${ICONS.drive}</span>
              <span>DOWNLOAD TO DISK</span>
            </button>
            <button class="btn btn-danger btn-sm btn-icon" onclick="deleteCloudMagnet(${m.id})" title="Delete from cloud">
              ${ICONS.trash}
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

// ============================================================
// Actions & Handlers
// ============================================================

window.openLocalFolder = async function (taskId) {
  try {
    const res = await fetch(`/api/downloads/${taskId}/open-folder`, { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    showToast('Opened destination directory in File Explorer', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.pauseTask = async function (taskId) {
  await fetch(`/api/downloads/${taskId}/pause`, { method: 'POST' });
  showToast('Download stream paused', 'info');
};

window.resumeTask = async function (taskId) {
  await fetch(`/api/downloads/${taskId}/resume`, { method: 'POST' });
  showToast('Download stream resumed', 'info');
};

window.retryTask = async function (taskId) {
  await fetch(`/api/downloads/${taskId}/retry`, { method: 'POST' });
  showToast('Retrying failed streams...', 'info');
};

window.cancelTask = async function (taskId) {
  if (confirm('Cancel and delete this task from pipeline?')) {
    await fetch(`/api/downloads/${taskId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteFiles: false }),
    });
    showToast('Task removed from pipeline', 'info');
  }
};

window.downloadCloudMagnet = async function (magnetId, name = '') {
  try {
    const res = await fetch(`/api/cloud-magnets/${magnetId}/download`, {
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
      const res = await fetch(`/api/cloud-magnets/${magnetId}/delete`, { method: 'POST' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      showToast('Deleted from AllDebrid cloud', 'success');
      fetchCloudMagnets();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }
};

// ============================================================
// File Tree Viewer Modal
// ============================================================

window.openFileTreeModal = async function (taskId) {
  state.currentTreeTaskId = taskId;
  elements.fileTreeModal.classList.add('active');
  elements.treeContentArea.innerHTML = `
    <div class="shimmer-card">
      <div class="shimmer-line header"></div>
      <div class="shimmer-line sub"></div>
    </div>
  `;

  try {
    const res = await fetch(`/api/downloads/${taskId}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const task = data.task;
    elements.treeModalTitle.textContent = `${task.name}`;

    if (!task.files || task.files.length === 0) {
      elements.treeContentArea.innerHTML = `
        <div class="empty-state" style="padding:20px;">
          <p>Querying directory topology from AllDebrid...</p>
        </div>
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
              <span class="status-pill ${f.status}" style="font-size:10px;padding:2px 8px;">
                ${isDone ? 'COMPLETE' : isError ? 'ERROR' : f.progress + '%'}
              </span>
            </div>
          </div>
        `;
      })
      .join('');
  } catch (err) {
    elements.treeContentArea.innerHTML = `<p style="color:var(--accent-primary);">${err.message}</p>`;
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
    tab.classList.toggle('active', tab.dataset.tab === tabId);
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
    <div class="shimmer-card" style="padding:12px;">
      <div class="shimmer-line" style="width:70%;"></div>
      <div class="shimmer-line" style="width:50%;"></div>
    </div>
  `;

  try {
    const url = targetPath ? `/api/browse-directory?path=${encodeURIComponent(targetPath)}` : '/api/browse-directory';
    const res = await fetch(url);
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
        <div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;" class="mono">
          NO SUBDIRECTORIES
        </div>
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
      <div style="padding:16px;color:var(--accent-primary);font-size:13px;" class="mono">
        DIRECTORY ERROR: ${err.message}
      </div>
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
    const res = await fetch('/api/create-directory', {
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

elements.browseDownloadDirBtn.onclick = () => {
  openFolderBrowser(elements.downloadDirInput.value.trim(), (selectedPath) => {
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
  elements.reviewFileCount.textContent = `${fileCount} FILES`;

  elements.reviewStatusBadge.textContent = primaryItem.isReady ? 'CLOUD READY' : 'WAITING FOR CLOUD';
  elements.reviewStatusBadge.style.color = primaryItem.isReady ? 'var(--accent-success)' : 'var(--accent-amber)';

  elements.reviewOutputDirInput.value = primaryItem.defaultOutputDir;

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

elements.changeReviewDirBtn.onclick = () => {
  const currentDir = elements.reviewOutputDirInput.value.trim();
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
      <div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;" class="mono">
        Single stream or cloud cache pending. Directory topology will create automatically upon ingestion.
      </div>
    `;
    return;
  }

  elements.reviewTreeContainer.innerHTML = files
    .map((f) => {
      const isChecked = state.reviewSelectedPaths.has(f.relativePath);
      const iconSvg = getFileIconSvg(f.name);
      
      let diskBadge = '';
      if (f.isCompleteOnDisk) {
        diskBadge = '<span class="status-pill completed" style="font-size:9px;padding:2px 6px;">[ ON DISK - SKIP ]</span>';
      } else if (f.existsOnDisk && f.diskBytes > 0) {
        diskBadge = `<span class="status-pill downloading" style="font-size:9px;padding:2px 6px;">[ RESUME: ${formatBytes(f.diskBytes)} ]</span>`;
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

// Confirm & Launch Download from Review Screen
elements.confirmReviewDownloadBtn.onclick = async () => {
  if (state.reviewPreviews.length === 0) return;

  const chosenOutputDir = elements.reviewOutputDirInput.value.trim();
  const selectedList = Array.from(state.reviewSelectedPaths);

  if (selectedList.length === 0 && state.reviewPreviews[0].flattenedFiles?.length > 0) {
    showToast('Select at least one file to download', 'error');
    return;
  }

  elements.confirmReviewDownloadBtn.disabled = true;
  elements.confirmReviewDownloadBtn.textContent = 'DISPATCHING PIPELINE...';

  const itemsPayload = state.reviewPreviews.map((p) => ({
    type: p.type,
    magnetId: p.magnetId,
    url: p.url,
    name: p.name,
    filesTree: p.filesTree,
    customOutputDir: chosenOutputDir,
    selectedFiles: selectedList.length > 0 ? selectedList : null,
  }));

  try {
    const res = await fetch('/api/downloads/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: itemsPayload }),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error);

    showToast(`Dispatched ${data.addedCount} task(s) into pipeline!`, 'success');
    closeDownloadReview();
    closeAddModal();
    switchTab('active');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    elements.confirmReviewDownloadBtn.disabled = false;
    elements.confirmReviewDownloadBtn.innerHTML = `
      <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
      <span>CONFIRM &amp; DISPATCH TASK</span>
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
  elements.submitAddBtn.textContent = 'ANALYZING TOPOLOGY...';

  try {
    const res = await fetch('/api/downloads/preview', {
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
    elements.submitAddBtn.textContent = 'INSPECT & REVIEW STRUCTURE';
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
  elements.submitUploadBtn.textContent = 'INSPECTING TORRENT...';

  try {
    const res = await fetch('/api/downloads/preview', {
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
    elements.submitUploadBtn.textContent = 'INSPECT & DOWNLOAD';
  }
};

// ============================================================
// Settings Management
// ============================================================

elements.maxConcurrentRange.oninput = () => {
  elements.maxConcurrentVal.textContent = `${elements.maxConcurrentRange.value} WORKERS`;
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
  };

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error);

    showToast('Configuration persisted successfully!', 'success');
    fetchStatus();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

elements.testApiBtn.onclick = async () => {
  elements.testApiBtn.disabled = true;
  elements.testApiBtn.textContent = 'VERIFYING...';

  try {
    // If user entered a key in input, save it first
    if (elements.apiKeyInput.value.trim()) {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newApiKey: elements.apiKeyInput.value.trim() }),
      });
    }

    const res = await fetch('/api/status');
    const data = await res.json();

    if (data.userInfo) {
      showToast(`Credentials Valid: Node active as ${data.userInfo.username} (Premium: ${data.userInfo.isPremium ? 'YES' : 'EXPIRED'})`, 'success');
    } else {
      showToast(`Verification Failed: ${data.userError || 'Invalid API Key'}`, 'error');
    }
    fetchStatus();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    elements.testApiBtn.disabled = false;
    elements.testApiBtn.textContent = 'VERIFY CREDENTIALS';
  }
};

// Search Filter Listeners
elements.activeSearchInput.oninput = renderTasks;
elements.completedSearchInput.oninput = renderTasks;
elements.cloudSearchInput.oninput = renderCloudMagnets;
elements.refreshCloudBtn.onclick = fetchCloudMagnets;

// Initial Bootstrap
connectWebSocket();
fetchStatus();
