<div align="center">

# ⚡ ALLDEBRID CORE

### High-Performance Debrid Download Engine • Multi-Part Archive Unpacker • Modern HPC Web Interface

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-00BFFF?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-ISC-00FF66?style=for-the-badge)](LICENSE)
[![AllDebrid API](https://img.shields.io/badge/AllDebrid_API-v4%20%2F%20v4.1-FF3366?style=for-the-badge&logo=cloud&logoColor=white)](https://docs.alldebrid.com/)
[![WebSockets](https://img.shields.io/badge/Telemetry-Live_WebSockets-FFAA00?style=for-the-badge&logo=websocket&logoColor=white)](https://github.com/websockets/ws)

<br/>

A modern, full-featured, and self-hosted torrent, file hoster, and cloud download engine powered by **AllDebrid**. Built from the ground up for massive throughput, resilient chunk resuming, folder structure preservation, and automated archive decompression.

</div>

---

## 🌟 Key Features

### 🚀 Torrent & Magnet Pipeline
* **Multiple Ingestion Formats**: Ingest `magnet:?xt=urn:btih:...`, 40-character InfoHashes, AllDebrid `getMagnet/<id>` links, and uploaded `.torrent` files (drag-and-drop enabled).
* **Topology Inspector**: Inspect directory trees, select individual files, and skip or resume files that already exist on disk before queueing.
* **AllDebrid Cloud Sync**: Browse, download to disk, restart, or delete torrents stored in your AllDebrid cloud cache directly from the UI.

### 📂 Folder Crawling & Direct Hosters
* **Rapidgator Folder Crawling**: Ingest entire Rapidgator (`rapidgator.net` / `rg.to`) folder URLs with pagination support. Automatically extracts all multi-part files, sizes, and names into a unified folder task.
* **Direct Link Unlocking**: Unlock hoster links via AllDebrid's high-speed CDN network with automatic name and size resolution.

### 📦 Automated Multi-Part Archive Extraction
* **Smart Archive Detection**: Automatically detects multi-part archive sets (`.part1.rar`, `.part01.rar`, `.r00`, `.zip.001`, `.7z.001`, `.zip`, `.tar.gz`, etc.).
* **Zero External Dependencies**: Seamlessly detects and uses system extractors (`7-Zip` `7z.exe`, `WinRAR` `UnRAR.exe`, or `tar.exe`).
* **Auto-Extract on Completion**: Automatically unpacks archives into the destination folder once downloads finish.
* **Part File Cleanup (Space Saver)**: Optionally deletes source `.part*.rar` / `.zip` archive parts after successful decompression to reclaim storage.
* **Manual Trigger**: Extract any completed download anytime with a single click.

### ⚡ High-Performance Computing (HPC) Architecture
* **Stream-Based Range Resuming**: HTTP `Range` request resuming prevents redownloading upon interruptions.
* **Mechanical Drive Protection**: Tuned backpressure buffers (512KB chunks) for smooth sequential writes on external USB HDDs and fast SSDs.
* **Configurable Concurrency**: Tune worker streams (1–10 streams) directly from the settings panel.
* **Live WebSocket Telemetry**: Real-time throughput metrics, progress ticks, ETA recalculations, and per-file progress streamed to the frontend.

### 🖥️ Futuristic Cyberpunk Web Interface
* **HPC Dashboard**: Modern glassmorphic dark theme, live throughput speedometer, status pills, and search filters.
* **Filesystem Browser**: Interactive directory picker with multi-drive switching (`C:\`, `D:\`, `F:\`), parent directory navigation, and new folder creation.

---

## 📸 Interface Preview

```
+---------------------------------------------------------------------------------------+
|  ⚡ ALLDEBRID CORE   HPC DOWNLOAD ENGINE • v4.2       [ THROUGHPUT: 85.4 MB/s ] [ NEW TASK ] |
+---------------------------------------------------------------------------------------+
|  [ Active Pipeline (2) ]  [ Completed (14) ]  [ Cloud Storage (5) ]  [ Engine Config ] |
+---------------------------------------------------------------------------------------+
|                                                                                       |
|  📁 Dataset_Archive_Bundle                                [ EXTRACTING ARCHIVE... ]   |
|     8 FILES • 7.41 GB / 7.41 GB • ⚡ AUTO-EXTRACT                                     |
|     [======================================================== 100% ]                  |
|     SPEED: --  •  PROGRESS: 100%  •  ⚡ DECOMPRESSING ARCHIVE FILES...                 |
|     [ STRUCTURE ] [ OPEN FOLDER ] [ EXTRACT ]                                         |
|                                                                                       |
|  📁 Linux_Ubuntu_24.04_LTS                                [ DOWNLOADING ]             |
|     1 FILES • 1.20 GB / 4.80 GB                                                       |
|     [======================--------------------------------- 25% ]                   |
|     SPEED: 85.4 MB/s  •  PROGRESS: 25%  •  ETA: 42s                                   |
|     [ STRUCTURE ] [ OPEN FOLDER ] [ PAUSE ] [ CANCEL ]                                |
|                                                                                       |
+---------------------------------------------------------------------------------------+
```

---

## 🛠️ Tech Stack

* **Backend**: Node.js (ES Modules), Express 4, WebSocket (`ws`), Multer
* **Frontend**: Vanilla HTML5, Vanilla CSS3 (Custom HPC Design System), Vanilla JavaScript
* **API Integration**: AllDebrid REST API v4 & v4.1
* **Decompression Engine**: System-level integration with `7-Zip`, `WinRAR`, and `tar`

---

## 🚀 Quick Start

### Prerequisites
* [Node.js](https://nodejs.org/) v18.0.0 or higher
* [AllDebrid Account](https://alldebrid.com/) & [API Key](https://alldebrid.com/apikeys)
* *(Optional, for archive extraction)*: [7-Zip](https://www.7-zip.org/) or [WinRAR](https://www.win-rar.com/) installed on the host system.

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/your-username/alldebrid-downloader.git
cd alldebrid-downloader
npm install
```

### 2. Environment Configuration
Create a `.env` file in the root directory (or copy `.env.example`):
```env
# AllDebrid API Key (Generate from https://alldebrid.com/apikeys)
ALLDEBRID_API_KEY=your_alldebrid_api_key_here

# Server Configuration
PORT=3000

# Download Settings
DOWNLOAD_DIR=./downloads
MAX_CONCURRENT_DOWNLOADS=3
```

> **Note**: You can also configure your API key and download directory directly within the Web UI under the **Engine Config** tab.

### 3. Run the Server
```bash
# Production mode
npm start

# Development mode (with auto-reload)
npm run dev
```

Open your browser and navigate to:
```
http://localhost:3000
```

---

## 📖 Usage Guide

### 1. Downloading Torrents & Magnet Links
1. Click **NEW TASK** in the top navigation.
2. Paste a Magnet URI, InfoHash, or AllDebrid `getMagnet/<id>` link, or drag and drop `.torrent` files into the **UPLOAD .TORRENT** tab.
3. Click **INSPECT & REVIEW STRUCTURE**.
4. Select the destination folder and verify files.
5. Click **CONFIRM & DISPATCH TASK**.

### 2. Downloading Rapidgator Folders
1. Click **NEW TASK**.
2. Paste any Rapidgator folder URL:
   ```
   https://rapidgator.net/folder/1234567/sample_folder.html
   ```
3. Click **INSPECT & REVIEW STRUCTURE**.
4. The system will crawl the folder, fetch all pages, and list all files in the folder.
5. Enable **AUTO-EXTRACT ARCHIVE(S)** and optionally **DELETE PART FILES AFTER EXTRACTION**.
6. Click **CONFIRM & DISPATCH TASK**. All files will download into the destination folder and automatically unpack!

### 3. Archive Extraction & Space Saver
* **Auto-Extract**: When downloading multi-part `.rar`, `.zip`, or `.7z` archives, check **AUTO-EXTRACT ARCHIVE(S)** in the review modal. Once all files are downloaded, the engine automatically decompresses them into the task folder.
* **Delete Part Files**: Check **DELETE PART FILES AFTER EXTRACTION** to delete `.part1.rar`, `.part2.rar`, etc., after successful extraction, preserving disk space.
* **Manual Extract**: Any completed task with archives has an **EXTRACT** button in the task card.

---

## ⚙️ Performance Tuning

| Storage Type | Recommended Concurrent Workers | Recommendation Note |
| :--- | :---: | :--- |
| **Mechanical USB HDD** | `1 - 2 Workers` | Minimizes random head seeking, maximizing sequential write speed. |
| **SATA SSD** | `3 - 5 Workers` | Ideal balance for high-speed fiber internet and flash storage. |
| **NVMe SSD / High-End** | `5 - 10 Workers` | Saturated multi-gigabit connections on high-performance storage. |

---

## 📡 REST API Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/status` | Get node status, AllDebrid account info, and live metrics. |
| `POST` | `/api/downloads/preview` | Preview torrent or folder topology before queueing. |
| `POST` | `/api/downloads/add` | Add confirmed download tasks to the pipeline. |
| `POST` | `/api/downloads/upload-torrent` | Ingest uploaded `.torrent` file(s). |
| `GET` | `/api/downloads` | List all active and completed tasks with metrics. |
| `GET` | `/api/downloads/:id` | Get full task details including file tree. |
| `POST` | `/api/downloads/:id/pause` | Pause active file streams for a task. |
| `POST` | `/api/downloads/:id/resume` | Resume paused or failed streams with HTTP Range resuming. |
| `POST` | `/api/downloads/:id/retry` | Retry failed files in a task. |
| `POST` | `/api/downloads/:id/cancel` | Cancel and delete task (with optional disk deletion). |
| `POST` | `/api/downloads/:id/open-folder` | Open task directory in OS File Explorer (Windows/macOS/Linux). |
| `POST` | `/api/downloads/:id/extract` | Manually trigger archive extraction on a completed task. |
| `GET` | `/api/cloud-magnets` | List torrents cached in AllDebrid cloud storage. |
| `POST` | `/api/cloud-magnets/:id/download` | Queue a cloud torrent directly to local disk. |
| `POST` | `/api/cloud-magnets/:id/delete` | Delete a torrent from AllDebrid cloud account. |
| `GET` | `/api/browse-directory` | Browse local filesystem directories. |
| `POST` | `/api/create-directory` | Create a new local directory. |
| `GET` | `/api/settings` | Read current engine settings. |
| `POST` | `/api/settings` | Update settings and persist to `.env`. |

---

## 🔒 Security Best Practices

* **API Key Safety**: Your AllDebrid API key is stored strictly on your local machine in `.env` and is never exposed to third-party servers.
* **Input Sanitization**: File and folder paths are sanitized across Windows, Linux, and macOS to prevent path traversal vulnerabilities.

---

## 📄 License

This project is licensed under the [ISC License](LICENSE).
