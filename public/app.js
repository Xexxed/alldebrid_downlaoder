/**
 * AllDebrid Downloader Frontend Application
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
// Utilities
// ============================================================

function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
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

function getFileIcon(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts'];
  const audioExts = ['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a'];
  const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz', 'iso'];
  const docExts = ['pdf', 'epub', 'txt', 'nfo', 'doc', 'docx'];
  const imgExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];

  if (videoExts.includes(ext)) return '🎬';
  if (audioExts.includes(ext)) return '🎵';
  if (archiveExts.includes(ext)) return '📦';
  if (docExts.includes(ext)) return '📄';
  if (imgExts.includes(ext)) return '🖼️';
  return '📄';
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
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
    elements.wsStatus.innerHTML = '<span class="status-dot"></span> Live';
    elements.wsStatus.style.color = '#10b981';
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
    elements.wsStatus.innerHTML = '<span class="status-dot" style="background:#f43f5e;box-shadow:0 0 8px #f43f5e;"></span> Offline';
    elements.wsStatus.style.color = '#f43f5e';
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
    showToast(`Completed: ${msg.task.name}`, 'success');
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
      elements.userStatusIcon.textContent = isPrem ? '⭐' : '👤';
      elements.userStatusLabel.textContent = isPrem ? 'Premium Account' : 'Free Account';
      elements.userStatusValue.textContent = `${u.username || 'User'}`;
      elements.userPill.style.borderColor = isPrem ? 'rgba(16, 185, 129, 0.4)' : 'rgba(245, 158, 11, 0.4)';
    } else if (data.hasApiKey && data.userError) {
      elements.userStatusIcon.textContent = '⚠️';
      elements.userStatusLabel.textContent = 'AllDebrid Error';
      elements.userStatusValue.textContent = 'Invalid Key';
      elements.userPill.style.borderColor = 'rgba(244, 63, 94, 0.4)';
    } else {
      elements.userStatusIcon.textContent = '🔑';
      elements.userStatusLabel.textContent = 'API Key';
      elements.userStatusValue.textContent = 'Not Configured';
      elements.userPill.style.borderColor = 'rgba(245, 158, 11, 0.4)';
    }

    // Populate settings form
    elements.downloadDirInput.value = data.downloadDir || '';
    elements.maxConcurrentRange.value = data.maxConcurrent || 3;
    elements.maxConcurrentVal.textContent = data.maxConcurrent || 3;
  } catch (err) {
    console.error('Failed to fetch status:', err);
  }
}

async function fetchCloudMagnets() {
  elements.cloudTorrentsList.innerHTML = `
    <div class="loading-spinner-container">
      <div class="spinner"></div>
      <p>Loading cloud magnets from AllDebrid...</p>
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
        <div class="empty-icon">⚠️</div>
        <h3>Failed to Load Cloud Torrents</h3>
        <p>${err.message}</p>
        <button class="btn btn-secondary" onclick="fetchCloudMagnets()">Try Again</button>
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
  elements.activeStatsText.textContent = `${activeCount} tasks in queue`;
  elements.completedStatsText.textContent = `${completedCount} completed tasks`;
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

  let statusText = task.status.replace(/_/g, ' ');
  if (isWaitingCloud) statusText = `Cloud Processing (${task.cloudProgress || 0}%)`;

  let typeIcon = task.type === 'torrent' ? '📁' : '🔗';

  return `
    <div class="task-card" data-task-id="${task.id}">
      <div class="task-header">
        <div class="task-title-area">
          <div class="task-type-icon">${typeIcon}</div>
          <div class="task-info-block">
            <div class="task-name" title="${task.name}">${task.name}</div>
            <div class="task-meta">
              <span class="task-folder-tag">📂 ${task.fileCount || 1} files preserved</span>
              <span>${formatBytes(task.downloadedSize)} / ${formatBytes(task.totalSize)}</span>
              ${task.error ? `<span style="color:var(--accent-rose)">⚠️ ${task.error}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="status-badge ${task.status}">
          ${isDownloading ? '<span class="status-dot"></span>' : ''}
          ${statusText}
        </div>
      </div>

      <div class="progress-container">
        <div class="progress-track">
          <div class="progress-fill ${isCompleted ? 'completed' : isError ? 'error' : isDownloading ? 'active-glow' : ''}" 
               style="width: ${task.progress || 0}%"></div>
        </div>
      </div>

      <div class="task-footer">
        <div class="task-metrics">
          <div class="metric-item percent">${task.progress || 0}%</div>
          ${isDownloading ? `<div class="metric-item speed">⚡ ${formatSpeed(task.speed)}</div>` : ''}
          ${isDownloading && task.eta > 0 ? `<div class="metric-item">⏱️ ETA: ${formatEta(task.eta)}</div>` : ''}
          ${isCompleted ? `<div class="metric-item" style="color:var(--accent-emerald)">✓ Saved to disk</div>` : ''}
        </div>

        <div class="task-actions">
          <button class="btn btn-secondary btn-sm" onclick="openFileTreeModal('${task.id}')" title="Inspect files and preserved subfolders">
            📁 Structure
          </button>
          
          ${isCompleted || task.downloadedSize > 0 ? `
            <button class="btn btn-secondary btn-sm" onclick="openLocalFolder('${task.id}')" title="Open in File Explorer">
              📂 Open Folder
            </button>
          ` : ''}

          ${isDownloading ? `
            <button class="btn btn-secondary btn-sm" onclick="pauseTask('${task.id}')" title="Pause Download">
              ⏸️ Pause
            </button>
          ` : ''}

          ${isPaused ? `
            <button class="btn btn-secondary btn-sm" onclick="resumeTask('${task.id}')" title="Resume Download">
              ▶️ Resume
            </button>
          ` : ''}

          ${isError ? `
            <button class="btn btn-secondary btn-sm" onclick="retryTask('${task.id}')" title="Retry Download">
              🔄 Retry
            </button>
          ` : ''}

          <button class="btn btn-danger btn-sm" onclick="cancelTask('${task.id}')" title="Cancel & Remove">
            🗑️
          </button>
        </div>
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
        <div class="empty-icon">☁️</div>
        <h3>No Cloud Magnets Found</h3>
        <p>Torrents uploaded or cached on your AllDebrid account will show up here.</p>
      </div>
    `;
    return;
  }

  elements.cloudTorrentsList.innerHTML = filtered
    .map((m) => {
      const isReady = m.statusCode === 4 || m.status === 'Ready';
      const isDownloading = m.statusCode === 1 || m.status === 'Downloading';
      const isError = m.statusCode >= 5;

      const progress = m.size > 0 ? Math.round((m.downloaded / m.size) * 100) : isReady ? 100 : 0;

      return `
        <div class="cloud-item-card">
          <div class="cloud-item-info">
            <div class="cloud-item-icon">${isReady ? '✅' : isDownloading ? '⚡' : '☁️'}</div>
            <div class="cloud-item-details">
              <div class="cloud-item-title" title="${m.filename || 'Torrent ' + m.id}">${m.filename || 'Torrent #' + m.id}</div>
              <div class="cloud-item-meta">
                <span>${formatBytes(m.size)}</span>
                <span>•</span>
                <span>${m.status || 'Active'} (${progress}%)</span>
                ${m.seeders !== undefined ? `<span>• 👥 ${m.seeders} seeders</span>` : ''}
                ${m.downloadSpeed > 0 ? `<span>• ⚡ ${formatSpeed(m.downloadSpeed)}</span>` : ''}
              </div>
            </div>
          </div>
          <div class="cloud-item-actions">
            <button class="btn btn-primary btn-sm btn-glow" onclick="downloadCloudMagnet(${m.id})">
              ⬇️ Download to Local Disk
            </button>
            <button class="btn btn-danger btn-sm" onclick="deleteCloudMagnet(${m.id})" title="Delete from AllDebrid Cloud">
              🗑️
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
    showToast('Opened folder in File Explorer', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.pauseTask = async function (taskId) {
  await fetch(`/api/downloads/${taskId}/pause`, { method: 'POST' });
  showToast('Download paused', 'info');
};

window.resumeTask = async function (taskId) {
  await fetch(`/api/downloads/${taskId}/resume`, { method: 'POST' });
  showToast('Download resumed', 'info');
};

window.retryTask = async function (taskId) {
  await fetch(`/api/downloads/${taskId}/retry`, { method: 'POST' });
  showToast('Retrying download...', 'info');
};

window.cancelTask = async function (taskId) {
  if (confirm('Cancel and remove this download?')) {
    await fetch(`/api/downloads/${taskId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteFiles: false }),
    });
    showToast('Download cancelled', 'info');
  }
};

window.downloadCloudMagnet = async function (magnetId) {
  try {
    const res = await fetch(`/api/cloud-magnets/${magnetId}/download`, { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    showToast('Added cloud torrent to local download queue!', 'success');
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

      showToast('Deleted from cloud', 'success');
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
  elements.treeContentArea.innerHTML = '<div class="spinner"></div>';

  try {
    const res = await fetch(`/api/downloads/${taskId}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const task = data.task;
    elements.treeModalTitle.textContent = `📁 ${task.name}`;

    if (!task.files || task.files.length === 0) {
      elements.treeContentArea.innerHTML = `
        <div class="empty-state" style="padding:20px;">
          <p>File list is being generated from AllDebrid cloud...</p>
        </div>
      `;
      return;
    }

    elements.treeContentArea.innerHTML = task.files
      .map((f) => {
        const isDone = f.status === 'completed';
        const isError = f.status === 'error';
        const icon = getFileIcon(f.name);
        return `
          <div class="tree-node">
            <div class="tree-node-left">
              <span class="tree-icon">${icon}</span>
              <span class="tree-name" title="${f.relativePath}">${f.relativePath}</span>
            </div>
            <div class="tree-node-right">
              <span>${formatBytes(f.size)}</span>
              <span class="status-badge ${f.status}" style="font-size:11px;padding:2px 8px;">
                ${isDone ? '✓ Saved' : isError ? '❌ Error' : f.progress + '%'}
              </span>
            </div>
          </div>
        `;
      })
      .join('');
  } catch (err) {
    elements.treeContentArea.innerHTML = `<p style="color:var(--accent-rose)">${err.message}</p>`;
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
    document.querySelectorAll('.modal-tab-pane').forEach((p) => p.classList.remove('active'));

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
  elements.browserFoldersList.innerHTML = '<div class="spinner" style="margin:20px auto;"></div>';

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
              💾 ${d}
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
        <div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;">
          No subfolders in this directory
        </div>
      `;
    } else {
      elements.browserFoldersList.innerHTML = data.directories
        .map(
          (d) => `
          <div class="folder-item" onclick="loadDirectory('${d.path.replace(/\\/g, '\\\\')}')">
            <span class="folder-item-icon">📁</span>
            <span class="folder-item-name" title="${d.name}">${d.name}</span>
          </div>
        `
        )
        .join('');
    }
  } catch (err) {
    elements.browserFoldersList.innerHTML = `
      <div style="padding:16px;color:var(--accent-rose);font-size:13px;">
        ⚠️ Error: ${err.message}
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
  showToast(`Selected directory: ${chosenPath}`, 'info');
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
  elements.reviewFileCount.textContent = `${fileCount} files`;

  elements.reviewStatusBadge.textContent = primaryItem.isReady ? 'Ready on Cloud' : 'Waiting for Cloud';
  elements.reviewStatusBadge.style.color = primaryItem.isReady ? '#6ee7b7' : '#fcd34d';

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
      <div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;">
        Torrent is being fetched or contains 1 single stream. Folder structure will be created automatically once ready.
      </div>
    `;
    return;
  }

  elements.reviewTreeContainer.innerHTML = files
    .map((f, idx) => {
      const isChecked = state.reviewSelectedPaths.has(f.relativePath);
      const icon = getFileIcon(f.name);
      
      let diskBadge = '';
      if (f.isCompleteOnDisk) {
        diskBadge = '<span class="status-badge completed" style="font-size:10px;padding:2px 6px;margin-right:8px;">✓ On Disk (Skipped)</span>';
      } else if (f.existsOnDisk && f.diskBytes > 0) {
        diskBadge = `<span class="status-badge downloading" style="font-size:10px;padding:2px 6px;margin-right:8px;">⚡ Resume from ${formatBytes(f.diskBytes)}</span>`;
      }

      return `
        <label class="review-file-row ${f.isCompleteOnDisk ? 'already-downloaded' : ''}">
          <div class="review-file-left">
            <input type="checkbox" data-path="${f.relativePath}" ${isChecked ? 'checked' : ''} onchange="toggleReviewFile('${f.relativePath}')" />
            <span class="tree-icon">${icon}</span>
            <span class="review-path-text" title="${f.relativePath}">${f.relativePath}</span>
          </div>
          <div class="review-file-size" style="display:flex;align-items:center;">
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
    showToast('Please select at least one file to download', 'error');
    return;
  }

  elements.confirmReviewDownloadBtn.disabled = true;
  elements.confirmReviewDownloadBtn.textContent = 'Queueing...';

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

    showToast(`Successfully verified & added ${data.addedCount} download(s)!`, 'success');
    closeDownloadReview();
    closeAddModal();
    switchTab('active');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    elements.confirmReviewDownloadBtn.disabled = false;
    elements.confirmReviewDownloadBtn.textContent = '🚀 Confirm & Start Download';
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
  elements.submitAddBtn.textContent = 'Inspecting Structure...';

  try {
    const res = await fetch('/api/downloads/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!data.previews || data.previews.length === 0) {
      throw new Error(data.errors?.[0] || 'No downloadable torrent structure found for input');
    }

    elements.addDownloadModal.classList.remove('active');
    openDownloadReview(data.previews);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    elements.submitAddBtn.disabled = false;
    elements.submitAddBtn.textContent = 'Review & Start Download';
  }
};

// Submit Upload .torrent -> Trigger Preview
elements.submitUploadBtn.onclick = async () => {
  if (state.selectedTorrentFiles.length === 0) return;

  const formData = new FormData();
  state.selectedTorrentFiles.forEach((file) => {
    formData.append('torrents', file);
  });

  elements.submitUploadBtn.disabled = true;
  elements.submitUploadBtn.textContent = 'Inspecting Torrent...';

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
    elements.submitUploadBtn.textContent = 'Review & Download';
  }
};

// ============================================================
// Settings Management
// ============================================================

elements.maxConcurrentRange.oninput = () => {
  elements.maxConcurrentVal.textContent = elements.maxConcurrentRange.value;
};

elements.toggleApiKeyVisibility.onclick = () => {
  const isPw = elements.apiKeyInput.type === 'password';
  elements.apiKeyInput.type = isPw ? 'text' : 'password';
  elements.toggleApiKeyVisibility.textContent = isPw ? '🔒' : '👁️';
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

    showToast('Settings saved successfully!', 'success');
    fetchStatus();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

elements.testApiBtn.onclick = async () => {
  elements.testApiBtn.disabled = true;
  elements.testApiBtn.textContent = 'Testing...';

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
      showToast(`API Key Valid! Welcome ${data.userInfo.username} (Premium: ${data.userInfo.isPremium ? 'Active' : 'Expired'})`, 'success');
    } else {
      showToast(`Verification Failed: ${data.userError || 'Invalid API Key'}`, 'error');
    }
    fetchStatus();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    elements.testApiBtn.disabled = false;
    elements.testApiBtn.textContent = 'Verify API Key';
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
