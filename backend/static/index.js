// Extract notebook ID from URL path /workspace/{notebook_id}
(function() {
  const pathParts = window.location.pathname.split('/');
  const notebookId = (pathParts[1] === 'workspace' && pathParts[2]) ? pathParts[2] : 'default';

  // Wrap fetch to automatically append the X-Notebook-ID header
  const originalFetch = window.fetch;
  window.fetch = async function(resource, init) {
    if (typeof resource === 'string' && resource.startsWith('/api/')) {
      init = init || {};
      init.headers = init.headers || {};
      if (init.headers instanceof Headers) {
        init.headers.set('X-Notebook-ID', notebookId);
      } else {
        init.headers['X-Notebook-ID'] = notebookId;
      }
    }
    return originalFetch(resource, init);
  };

  // Wrap XMLHttpRequest to automatically append the X-Notebook-ID header
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    this._url = url;
    return originalOpen.apply(this, [method, url, ...args]);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    if (typeof this._url === 'string' && this._url.startsWith('/api/')) {
      this.setRequestHeader('X-Notebook-ID', notebookId);
    }
    return originalSend.apply(this, args);
  };
})();

// Frontend state variables
let activeDocId = null;
let activeDocType = 'pdf';
let activePageNum = 1;
let activeNodeId = null; // Track active outline node for section text retrieval
let currentTab = 'image'; // 'image' or 'text'
let documents = [];
const selectedChatDocIds = new Set();
let isLibraryInitialLoad = true;

// DOM Elements
const themeToggle = document.getElementById('theme-toggle');
const statusOllama = document.getElementById('status-ollama');
const statusXinference = document.getElementById('status-xinference');

const settingsProvider = document.getElementById('settings-provider');
const settingsModel = document.getElementById('settings-model');
const settingsBase = document.getElementById('settings-base');
const settingsKey = document.getElementById('settings-key');
// settings-use-vlm removed
const settingsVlmProvider = document.getElementById('settings-vlm-provider');
const settingsVlmModel = document.getElementById('settings-vlm-model');
const settingsVlmBase = document.getElementById('settings-vlm-base');
const settingsVlmKey = document.getElementById('settings-vlm-key');
const saveChatBtn = document.getElementById('save-chat-btn');
const saveVlmBtn = document.getElementById('save-vlm-btn');
const vlmModelContainer = document.getElementById('vlm-model-container');
const apiKeyContainer = document.getElementById('api-key-container');
const apiBaseContainer = document.getElementById('api-base-container');
const vlmApiKeyContainer = document.getElementById('vlm-api-key-container');
const vlmApiBaseContainer = document.getElementById('vlm-api-base-container');

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const docList = document.getElementById('doc-list');
const uploadProgressContainer = document.getElementById('upload-progress-container');
const uploadFilename = document.getElementById('upload-filename');
const uploadPercent = document.getElementById('upload-percent');
const uploadProgressBar = document.getElementById('upload-progress-bar');

const activeDocIcon = document.getElementById('active-doc-icon');
const activeDocTitle = document.getElementById('active-doc-title');
const activeDocPages = document.getElementById('active-doc-pages');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const chatFallback = null;
const chatForceSearch = null;

const treeContainer = document.getElementById('tree-container');
const tabImageBtn = document.getElementById('tab-image-btn');
const tabTextBtn = document.getElementById('tab-text-btn');
const tabImageContent = document.getElementById('tab-image-content');
const tabTextContent = document.getElementById('tab-text-content');
const pageImageDisplay = document.getElementById('page-image-display');
const pageTextDisplay = document.getElementById('page-text-display');
const imageViewerPlaceholder = document.getElementById('image-viewer-placeholder');
const textViewerPlaceholder = document.getElementById('text-viewer-placeholder');

// Configure Marked options
marked.setOptions({
  breaks: true,
  gfm: true
});

let pollingInterval = null;
let activeTasks = [];
let isPolling = false;

// Init functions
document.addEventListener('DOMContentLoaded', () => {
  setupTheme();
  setupSettingsUI();
  setupCollapsibleSettings();
  setupUploadUI();
  setupTabsUI();
  setupChatUI();
  setupSplitPanes();
  setupSelectAllUI();

  // Tasks queue logic on startup
  pollTasks();
  startQueuePolling();

  // Clear completed tasks button
  const clearTasksBtn = document.getElementById('clear-tasks-btn');
  if (clearTasksBtn) {
    clearTasksBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/tasks/clear', { method: 'POST' });
        if (res.ok) {
          pollTasks();
        }
      } catch (e) {
        console.error("Failed to clear tasks:", e);
      }
    });
  }

  // Initial Status and Library fetch
  fetchStatus();
  fetchLibrary();

  // Poll connection status every 15s
  setInterval(fetchStatus, 15000);
});

// ── Theme Switcher (Dark / Light) ───────────────────────────────────────────
function setupTheme() {
  const isDark = localStorage.getItem('theme') !== 'light';
  if (isDark) {
    document.documentElement.classList.add('dark');
    themeToggle.innerHTML = '<span class="material-symbols-outlined">light_mode</span>';
  } else {
    document.documentElement.classList.remove('dark');
    themeToggle.innerHTML = '<span class="material-symbols-outlined">dark_mode</span>';
  }

  themeToggle.addEventListener('click', () => {
    const isCurrentlyDark = document.documentElement.classList.contains('dark');
    if (isCurrentlyDark) {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
      themeToggle.innerHTML = '<span class="material-symbols-outlined">dark_mode</span>';
    } else {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
      themeToggle.innerHTML = '<span class="material-symbols-outlined">light_mode</span>';
    }
  });
}

// ── Provider Settings ────────────────────────────────────────────────────────
function setupSettingsUI() {
  settingsProvider.addEventListener('change', () => {
    const provider = settingsProvider.value;
    if (provider === 'openai') {
      apiKeyContainer.classList.remove('hidden');
      apiBaseContainer.classList.remove('hidden');
      settingsBase.placeholder = "https://api.openai.com/v1";
    } else if (provider === 'xinference') {
      apiKeyContainer.classList.add('hidden');
      apiBaseContainer.classList.remove('hidden');
      settingsBase.placeholder = "http://localhost:9997";
    } else { // ollama
      apiKeyContainer.classList.add('hidden');
      apiBaseContainer.classList.remove('hidden');
      settingsBase.placeholder = "http://localhost:11434";
    }
  });

  settingsVlmProvider.addEventListener('change', () => {
    const provider = settingsVlmProvider.value;
    if (provider === 'openai') {
      vlmApiKeyContainer.classList.remove('hidden');
      vlmApiBaseContainer.classList.remove('hidden');
      settingsVlmBase.placeholder = "https://api.openai.com/v1";
    } else if (provider === 'xinference') {
      vlmApiKeyContainer.classList.add('hidden');
      vlmApiBaseContainer.classList.remove('hidden');
      settingsVlmBase.placeholder = "http://localhost:9997";
    } else { // ollama
      vlmApiKeyContainer.classList.add('hidden');
      vlmApiBaseContainer.classList.remove('hidden');
      settingsVlmBase.placeholder = "http://localhost:11434";
    }
  });

  // settingsUseVlm change listener removed

  saveChatBtn.addEventListener('click', saveChatSettings);
  saveVlmBtn.addEventListener('click', saveVlmSettings);
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    // Update active settings UI if empty or initial load
    if (!settingsModel.value) {
      settingsProvider.value = data.active_provider.provider_type;
      settingsProvider.dispatchEvent(new Event('change'));

      settingsModel.value = data.active_provider.model_name;
      settingsBase.value = data.active_provider.api_base || '';
      if (data.active_provider.api_key) {
        settingsKey.value = data.active_provider.api_key;
      }

      // settingsUseVlm update removed

      settingsVlmProvider.value = data.vlm_provider.provider_type || 'ollama';
      settingsVlmProvider.dispatchEvent(new Event('change'));

      settingsVlmModel.value = data.vlm_provider.model_name || '';
      settingsVlmBase.value = data.vlm_provider.api_base || '';
      if (data.vlm_provider.api_key) {
        settingsVlmKey.value = data.vlm_provider.api_key;
      }
    }

    // Update Ollama badge
    if (data.ollama.status === 'online') {
      statusOllama.className = "flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-500/10 text-green-500 font-medium border border-green-500/20";
      statusOllama.innerHTML = `<span class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span> Ollama: Online`;
      statusOllama.title = `Available models: ${data.ollama.models.join(', ')}`;
    } else {
      statusOllama.className = "flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/10 text-red-500 font-medium border border-red-500/20";
      statusOllama.innerHTML = `<span class="w-2 h-2 rounded-full bg-red-500"></span> Ollama: Offline`;
      statusOllama.title = "Could not connect to Ollama service.";
    }

    // Update Xinference badge
    if (data.xinference.status === 'online') {
      statusXinference.className = "flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-500/10 text-green-500 font-medium border border-green-500/20";
      statusXinference.innerHTML = `<span class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span> Xinference: Online`;
      statusXinference.title = `Available models: ${data.xinference.models.join(', ')}`;
    } else {
      statusXinference.className = "flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/10 text-red-500 font-medium border border-red-500/20";
      statusXinference.innerHTML = `<span class="w-2 h-2 rounded-full bg-red-500"></span> Xinference: Offline`;
      statusXinference.title = "Could not connect to Xinference service.";
    }
  } catch (e) {
    console.error("Failed to query status api", e);
  }
}

async function saveChatSettings() {
  saveChatBtn.disabled = true;
  saveChatBtn.innerHTML = '<span class="material-symbols-outlined text-sm animate-spin">sync</span> Saving...';

  const payload = {
    provider_type: settingsProvider.value,
    model_name: settingsModel.value,
    api_base: settingsBase.value || null,
    api_key: settingsKey.value || null
  };

  try {
    const res = await fetch('/api/settings/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      showToast("Chat settings saved and applied successfully!", "success");
      fetchStatus();
    } else {
      const err = await res.json();
      showToast(`Failed to update Chat settings: ${err.detail}`, "error");
    }
  } catch (e) {
    showToast(`Error updating Chat settings: ${e}`, "error");
  } finally {
    saveChatBtn.disabled = false;
    saveChatBtn.innerHTML = '<span class="material-symbols-outlined text-sm">save</span> Save Chat Settings';
  }
}

async function saveVlmSettings() {
  saveVlmBtn.disabled = true;
  saveVlmBtn.innerHTML = '<span class="material-symbols-outlined text-sm animate-spin">sync</span> Saving...';

  const payload = {
    use_vlm: true,
    vlm_provider_type: settingsVlmProvider.value,
    vlm_model: settingsVlmModel.value || null,
    vlm_api_base: settingsVlmBase.value || null,
    vlm_api_key: settingsVlmKey.value || null
  };

  try {
    const res = await fetch('/api/settings/vlm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      showToast("VLM settings saved and applied successfully!", "success");
      fetchStatus();
    } else {
      const err = await res.json();
      showToast(`Failed to update VLM settings: ${err.detail}`, "error");
    }
  } catch (e) {
    showToast(`Error updating VLM settings: ${e}`, "error");
  } finally {
    saveVlmBtn.disabled = false;
    saveVlmBtn.innerHTML = '<span class="material-symbols-outlined text-sm">save</span> Save VLM Settings';
  }
}

// ── Collapsible Settings Sections ───────────────────────────────────────────
function setupCollapsibleSettings() {
  const chatHeader = document.getElementById('chat-llm-header');
  const chatContent = document.getElementById('chat-llm-content');
  const chatChevron = document.getElementById('chat-llm-chevron');

  const vlmHeader = document.getElementById('vlm-parser-header');
  const vlmContent = document.getElementById('vlm-parser-content');
  const vlmChevron = document.getElementById('vlm-parser-chevron');

  // Load saved state
  const isChatCollapsed = localStorage.getItem('chat-llm-collapsed') === 'true';
  const isVlmCollapsed = localStorage.getItem('vlm-parser-collapsed') === 'true';

  if (isChatCollapsed && chatContent && chatChevron) {
    chatContent.classList.add('hidden');
    chatChevron.style.transform = 'rotate(-180deg)';
  }
  if (isVlmCollapsed && vlmContent && vlmChevron) {
    vlmContent.classList.add('hidden');
    vlmChevron.style.transform = 'rotate(-180deg)';
  }

  if (chatHeader && chatContent && chatChevron) {
    chatHeader.addEventListener('click', () => {
      const isHidden = chatContent.classList.toggle('hidden');
      chatChevron.style.transform = isHidden ? 'rotate(-180deg)' : 'rotate(0deg)';
      localStorage.setItem('chat-llm-collapsed', isHidden);
    });
  }

  if (vlmHeader && vlmContent && vlmChevron) {
    vlmHeader.addEventListener('click', () => {
      const isHidden = vlmContent.classList.toggle('hidden');
      vlmChevron.style.transform = isHidden ? 'rotate(-180deg)' : 'rotate(0deg)';
      localStorage.setItem('vlm-parser-collapsed', isHidden);
    });
  }
}

// ── File Upload & Drag-and-Drop ─────────────────────────────────────────────
function setupUploadUI() {
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('border-primary', 'bg-primary/5');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('border-primary', 'bg-primary/5');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('border-primary', 'bg-primary/5');
    if (e.dataTransfer.files.length > 0) {
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        handleUpload(e.dataTransfer.files[i]);
      }
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      for (let i = 0; i < fileInput.files.length; i++) {
        handleUpload(fileInput.files[i]);
      }
      fileInput.value = '';
    }
  });
}

function handleUpload(file) {
  const taskQueueContainer = document.getElementById('task-queue-container');
  if (taskQueueContainer) {
    taskQueueContainer.classList.remove('hidden');
  }

  const tasksList = document.getElementById('tasks-list');
  const tempTaskId = `upload-temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const uploadHtml = `
    <div id="${tempTaskId}" class="p-2 bg-surface border border-outline/10 rounded-lg space-y-1.5 shadow-sm">
      <div class="flex items-center justify-between text-[11px] font-semibold text-on-surface">
        <span class="truncate max-w-[170px]" title="${file.name}">${file.name}</span>
        <span class="upload-status-text text-[9px] font-bold text-primary animate-pulse uppercase">Uploading...</span>
      </div>
      <div class="w-full bg-outline/10 rounded-full h-1 overflow-hidden">
        <div class="upload-progress bg-primary h-1 rounded-full w-0 transition-all duration-300"></div>
      </div>
    </div>
  `;
  if (tasksList) {
    tasksList.insertAdjacentHTML('afterbegin', uploadHtml);
  }

  const tempElem = document.getElementById(tempTaskId);
  const progressBar = tempElem ? tempElem.querySelector('.upload-progress') : null;
  const statusText = tempElem ? tempElem.querySelector('.upload-status-text') : null;

  const formData = new FormData();
  formData.append('file', file);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload', true);

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable && progressBar && statusText) {
      const percent = Math.round((e.loaded / e.total) * 100);
      progressBar.style.width = `${percent}%`;
      if (percent === 100) {
        statusText.textContent = 'Queuing...';
      } else {
        statusText.textContent = `Uploading ${percent}%`;
      }
    }
  };

  xhr.onload = () => {
    if (xhr.status === 200) {
      if (tempElem) {
        tempElem.remove();
      }
      showToast(`Uploaded "${file.name}" to queue successfully!`, "success");
      pollTasks();
      startQueuePolling();
    } else {
      let err_msg = "Unknown error";
      try {
        err_msg = JSON.parse(xhr.responseText).detail || err_msg;
      } catch (e) { }
      if (statusText && progressBar) {
        statusText.textContent = 'Upload Failed';
        statusText.className = 'text-[9px] font-bold text-red-500 uppercase';
        progressBar.className = 'bg-red-500 h-1 rounded-full w-full';
      }
      showToast(`Upload failed: ${err_msg}`, "error");
      setTimeout(() => {
        if (tempElem) tempElem.remove();
      }, 5000);
    }
  };

  xhr.onerror = () => {
    if (statusText && progressBar) {
      statusText.textContent = 'Network Error';
      statusText.className = 'text-[9px] font-bold text-red-500 uppercase';
      progressBar.className = 'bg-red-500 h-1 rounded-full w-full';
    }
    showToast("Upload failed due to connection error.", "error");
    setTimeout(() => {
      if (tempElem) tempElem.remove();
    }, 5000);
  };

  xhr.send(formData);
}

// ── Background Tasks Queue Polling ──────────────────────────────────────────
async function pollTasks() {
  if (isPolling) return;
  isPolling = true;
  try {
    const res = await fetch('/api/tasks');
    if (!res.ok) throw new Error("Failed to fetch tasks");
    const tasks = await res.json();

    activeTasks = tasks;
    renderTasksQueue();

    const hasActive = tasks.some(t => t.status === 'pending' || t.status === 'processing');

    let newCompletion = false;
    tasks.forEach(t => {
      if (t.status === 'completed' && !selectedChatDocIds.has(t.doc_id)) {
        selectedChatDocIds.add(t.doc_id);
        newCompletion = true;
      }
    });

    if (newCompletion) {
      await fetchLibrary();
      const completedDocs = tasks.filter(t => t.status === 'completed');
      if (completedDocs.length > 0 && !activeDocId) {
        selectDocument(completedDocs[completedDocs.length - 1].doc_id);
      }
    }

    if (!hasActive) {
      stopQueuePolling();
    }
  } catch (e) {
    console.error("Error polling tasks:", e);
  } finally {
    isPolling = false;
  }
}

function startQueuePolling() {
  if (!pollingInterval) {
    pollingInterval = setInterval(pollTasks, 2000);
  }
}

function stopQueuePolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

function renderTasksQueue() {
  const taskQueueContainer = document.getElementById('task-queue-container');
  const tasksList = document.getElementById('tasks-list');
  if (!taskQueueContainer || !tasksList) return;

  if (activeTasks.length === 0) {
    const hasTempUploads = tasksList.querySelector('[id^="upload-temp-"]');
    if (!hasTempUploads) {
      taskQueueContainer.classList.add('hidden');
      return;
    }
  }

  taskQueueContainer.classList.remove('hidden');

  const tempElems = Array.from(tasksList.querySelectorAll('[id^="upload-temp-"]'));

  let html = activeTasks.map(task => {
    let badgeClass = '';
    let statusLabel = '';
    let progressBarHtml = '';

    if (task.status === 'pending') {
      badgeClass = 'bg-outline/10 text-on-surface-variant border border-outline/20';
      statusLabel = 'Queued';
      progressBarHtml = `
        <div class="w-full bg-outline/10 rounded-full h-1 overflow-hidden">
          <div class="bg-outline/35 h-1 rounded-full w-0"></div>
        </div>
      `;
    } else if (task.status === 'processing') {
      badgeClass = 'bg-primary/10 text-primary border border-primary/20 animate-pulse';
      statusLabel = 'Processing...';
      progressBarHtml = `
        <div class="w-full bg-outline/10 rounded-full h-1 overflow-hidden">
          <div class="bg-primary h-1 rounded-full w-full animate-pulse"></div>
        </div>
      `;
    } else if (task.status === 'completed') {
      badgeClass = 'bg-green-500/10 text-green-500 border border-green-500/20';
      statusLabel = 'Completed';
    } else if (task.status === 'failed') {
      badgeClass = 'bg-red-500/10 text-red-500 border border-red-500/20';
      statusLabel = 'Failed';
    }

    const errorDetails = task.error ? `<div class="text-[9px] text-red-500/90 font-medium leading-tight max-h-12 overflow-y-auto mt-1 bg-red-500/5 p-1 rounded border border-red-500/10" title="${task.error.replace(/"/g, '&quot;')}">${task.error}</div>` : '';

    return `
      <div id="task-${task.task_id}" class="p-2 bg-surface border border-outline/10 rounded-lg space-y-1.5 shadow-sm transition-all duration-200">
        <div class="flex items-center justify-between text-[11px] font-semibold text-on-surface">
          <span class="truncate max-w-[170px]" title="${task.filename}">${task.filename}</span>
          <span class="px-1.5 py-0.5 rounded text-[8px] font-bold uppercase ${badgeClass}">${statusLabel}</span>
        </div>
        ${progressBarHtml}
        ${errorDetails}
      </div>
    `;
  }).join('');

  tasksList.innerHTML = html;

  tempElems.forEach(el => {
    tasksList.insertBefore(el, tasksList.firstChild);
  });
}

// ── Library List ────────────────────────────────────────────────────────────
async function fetchLibrary() {
  try {
    const res = await fetch('/api/documents');
    documents = await res.json();

    if (isLibraryInitialLoad && documents.length > 0) {
      isLibraryInitialLoad = false;
      documents.forEach(doc => selectedChatDocIds.add(doc.doc_id));
      selectDocument(documents[0].doc_id);
    }

    renderLibrary();
  } catch (e) {
    console.error("Failed to query documents library", e);
  }
}

function renderLibrary() {
  const selectAllContainer = document.getElementById('select-all-container');
  const selectAllCheckbox = document.getElementById('select-all-checkbox');

  if (documents.length === 0) {
    docList.innerHTML = '<div class="text-xs text-on-surface-variant/70 text-center py-6">No documents indexed yet. Upload one to get started!</div>';
    if (selectAllContainer) {
      selectAllContainer.classList.remove('flex');
      selectAllContainer.classList.add('hidden');
    }
    updateChatHeader();
    return;
  }

  if (selectAllContainer && selectAllCheckbox) {
    selectAllContainer.classList.remove('hidden');
    selectAllContainer.classList.add('flex');
    const allChecked = documents.every(doc => selectedChatDocIds.has(doc.doc_id));
    selectAllCheckbox.checked = allChecked;
  }

  docList.innerHTML = documents.map(doc => {
    const isSelected = doc.doc_id === activeDocId;
    const activeClass = isSelected ? 'bg-primary/10 border-primary/40' : 'bg-surface border-outline/10 hover:bg-outline/5';
    const isChecked = selectedChatDocIds.has(doc.doc_id);
    const checkedAttr = isChecked ? 'checked' : '';

    // Choose icon based on file type
    let icon = 'draft';
    const ext = doc.doc_name.split('.').pop().toLowerCase();
    if (ext === 'pdf') icon = 'picture_as_pdf';
    else if (ext === 'docx') icon = 'description';
    else if (['png', 'jpg', 'jpeg'].includes(ext)) icon = 'image';
    else if (ext === 'md' || ext === 'markdown') icon = 'markdown';

    const metricText = doc.page_count > 0 ? `${doc.page_count} pages` : `${doc.line_count} lines`;
    const docNameEscaped = doc.doc_name.replace(/'/g, "\\'").replace(/"/g, '&quot;');

    return `
      <div onclick="selectDocument('${doc.doc_id}')" class="p-3 border rounded-xl flex items-center justify-between cursor-pointer transition-all duration-200 ${activeClass}">
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <input type="checkbox" onclick="event.stopPropagation(); toggleChatDocument('${doc.doc_id}')" ${checkedAttr} class="w-4 h-4 rounded text-primary border-outline/30 focus:ring-primary cursor-pointer shrink-0">
          <span class="material-symbols-outlined text-primary shrink-0">${icon}</span>
          <div class="min-w-0 flex-1">
            <div class="text-xs font-semibold text-on-surface truncate pr-1" title="${doc.doc_name}">${doc.doc_name}</div>
            <div class="text-[10px] text-on-surface-variant/80 font-medium mt-0.5">${metricText}</div>
          </div>
        </div>
        <div class="relative shrink-0 ml-1">
          <button onclick="event.stopPropagation(); toggleDocActionsMenu(event, '${doc.doc_id}')" class="p-1.5 rounded-lg hover:bg-outline/10 text-on-surface-variant hover:text-primary transition-colors" title="Document Actions">
            <span class="material-symbols-outlined text-base">more_vert</span>
          </button>
          
          <div id="actions-menu-${doc.doc_id}" class="hidden absolute right-0 mt-1 w-36 bg-surface-container-high border border-outline/15 rounded-xl shadow-xl z-50 flex flex-col py-1 text-xs text-on-surface">
            <button onclick="event.stopPropagation(); renameDocumentPrompt('${doc.doc_id}', '${docNameEscaped}')" class="flex items-center gap-2 px-3 py-2 hover:bg-outline/10 text-on-surface text-left transition-colors font-medium">
              <span class="material-symbols-outlined text-sm">edit</span> Rename
            </button>
            <button onclick="event.stopPropagation(); window.open('/api/documents/${doc.doc_id}/view', '_blank')" class="flex items-center gap-2 px-3 py-2 hover:bg-outline/10 text-on-surface text-left transition-colors font-medium">
              <span class="material-symbols-outlined text-sm">open_in_new</span> Download
            </button>
            <hr class="border-outline/10 my-1">
            <button onclick="event.stopPropagation(); deleteDocument('${doc.doc_id}')" class="flex items-center gap-2 px-3 py-2 hover:bg-red-500/10 text-red-500 hover:text-red-600 text-left transition-colors font-medium">
              <span class="material-symbols-outlined text-sm">delete</span> Delete
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  updateChatHeader();
}

async function deleteDocument(docId) {
  if (!confirm("Are you sure you want to delete this document from index? This will remove all structural caching and page visual assets.")) {
    return;
  }

  try {
    const res = await fetch(`/api/documents/${docId}`, { method: 'DELETE' });
    if (res.ok) {
      showToast("Document deleted successfully.", "success");
      selectedChatDocIds.delete(docId);
      if (activeDocId === docId) {
        activeDocId = null;
        const treeTitle = document.getElementById('inspector-tree-title');
        if (treeTitle) treeTitle.textContent = 'DOCUMENT TREE STRUCTURE';
        treeContainer.innerHTML = '<div class="text-on-surface-variant text-center py-10">Select a document to see its structural tree outline.</div>';
        clearPageDisplay();
      }
      fetchLibrary();
    } else {
      showToast("Failed to delete document.", "error");
    }
  } catch (e) {
    showToast(`Error deleting document: ${e}`, "error");
  }
}

async function selectDocument(docId) {
  activeDocId = docId;
  renderLibrary();

  const doc = documents.find(d => d.doc_id === docId);
  if (!doc) return;

  const treeTitle = document.getElementById('inspector-tree-title');
  if (treeTitle) {
    treeTitle.textContent = `STRUCTURE: ${doc.doc_name}`;
  }

  activeDocType = doc.type;

  // Fetch details and outline tree
  treeContainer.innerHTML = '<div class="text-xs text-on-surface-variant/80 text-center py-6"><span class="animate-spin inline-block mr-1">sync</span>Loading tree structure...</div>';

  try {
    const res = await fetch(`/api/documents/${docId}`);
    const details = await res.json();
    renderTree(details.structure);
    // Select first page automatically
    inspectPage(1);
  } catch (e) {
    treeContainer.innerHTML = `<div class="text-xs text-red-500 text-center py-6">Failed to load structure: ${e}</div>`;
  }
}

// ── PageIndex Tree outline ───────────────────────────────────────────────────
function renderTree(structure) {
  if (!structure || structure.length === 0) {
    treeContainer.innerHTML = '<div class="text-on-surface-variant text-center py-4">No structure outlines found.</div>';
    return;
  }

  function buildTreeNodeHTML(node) {
    const childrenList = node.children || node.nodes;
    const hasChildren = childrenList && childrenList.length > 0;
    const targetIdx = node.page !== undefined ? node.page : (node.start_index !== undefined ? node.start_index : (node.line_num !== undefined ? node.line_num : 1));
    const metricLabel = activeDocType === 'pdf' ? `p. ${targetIdx}` : `L ${targetIdx}`;

    let html = `
      <div class="tree-node flex flex-col pl-2 border-l border-outline/10 ml-1 mt-1">
        <div class="flex items-center justify-between p-1.5 rounded-lg hover:bg-outline/10 group cursor-pointer transition-colors" onclick="event.stopPropagation(); inspectNode('${node.node_id}', ${targetIdx})">
          <div class="flex items-center gap-1.5 min-w-0 flex-1">
            ${hasChildren ? `
              <button onclick="event.stopPropagation(); toggleNodeCollapse(this)" class="p-0.5 rounded hover:bg-outline/20 flex items-center justify-center shrink-0">
                <span class="material-symbols-outlined text-sm font-semibold transition-transform">keyboard_arrow_down</span>
              </button>
            ` : '<span class="w-4 shrink-0"></span>'}
            <span class="text-[11px] font-semibold text-on-surface truncate group-hover:text-primary transition-colors">${node.title}</span>
          </div>
          <span class="text-[9px] font-bold text-on-surface-variant/80 shrink-0 bg-outline/10 border border-outline/15 px-1.5 py-0.5 rounded">${metricLabel}</span>
        </div>
    `;

    if (hasChildren) {
      html += `<div class="node-children flex flex-col pl-2 mt-0.5 space-y-0.5">`;
      childrenList.forEach(child => {
        html += buildTreeNodeHTML(child);
      });
      html += `</div>`;
    }

    html += `</div>`;
    return html;
  }

  let treeHTML = '';
  structure.forEach(node => {
    treeHTML += buildTreeNodeHTML(node);
  });
  treeContainer.innerHTML = treeHTML;
}

function toggleNodeCollapse(btn) {
  const childrenContainer = btn.closest('.tree-node').querySelector('.node-children');
  const icon = btn.querySelector('.material-symbols-outlined');

  if (childrenContainer.classList.contains('hidden')) {
    childrenContainer.classList.remove('hidden');
    icon.style.transform = 'rotate(0deg)';
  } else {
    childrenContainer.classList.add('hidden');
    icon.style.transform = 'rotate(-90deg)';
  }
}

// ── Inspector Tab Navigation & Dual View ────────────────────────────────────
function setupTabsUI() {
  tabImageBtn.addEventListener('click', () => switchTab('image'));
  tabTextBtn.addEventListener('click', () => switchTab('text'));
}

function switchTab(tab) {
  currentTab = tab;
  if (tab === 'image') {
    tabImageBtn.className = "flex-1 py-2 text-xs font-semibold text-primary border-b-2 border-primary focus:outline-none flex items-center justify-center gap-1";
    tabTextBtn.className = "flex-1 py-2 text-xs font-semibold text-on-surface-variant border-b-2 border-transparent hover:bg-outline/5 focus:outline-none flex items-center justify-center gap-1";
    tabImageContent.classList.remove('hidden');
    tabTextContent.classList.add('hidden');
  } else {
    tabTextBtn.className = "flex-1 py-2 text-xs font-semibold text-primary border-b-2 border-primary focus:outline-none flex items-center justify-center gap-1";
    tabImageBtn.className = "flex-1 py-2 text-xs font-semibold text-on-surface-variant border-b-2 border-transparent hover:bg-outline/5 focus:outline-none flex items-center justify-center gap-1";
    tabImageContent.classList.add('hidden');
    tabTextContent.classList.remove('hidden');
  }

  // Reload content
  if (activeDocId) {
    loadPageContent();
  }
}

function clearPageDisplay() {
  pageImageDisplay.classList.add('hidden');
  pageTextDisplay.classList.add('hidden');
  imageViewerPlaceholder.classList.remove('hidden');
  textViewerPlaceholder.classList.remove('hidden');
}

function inspectPage(idx) {
  activePageNum = idx;
  activeNodeId = null; // Clear active node when page is manually selected or default

  if (activeDocId) {
    loadPageContent();
  }
}

function inspectNode(nodeId, pageNum) {
  activeNodeId = nodeId;
  activePageNum = pageNum;

  if (activeDocId) {
    loadPageContent();
  }
}

async function loadPageContent() {
  imageViewerPlaceholder.classList.add('hidden');
  textViewerPlaceholder.classList.add('hidden');

  // Load page image (only works for physical pdf pages or image uploads)
  const imagePageNum = activeDocType === 'pdf' ? activePageNum : 1;
  const imageApiUrl = `/api/documents/${activeDocId}/pages/${imagePageNum}/image`;

  // Setup loading state
  pageImageDisplay.classList.add('hidden');
  pageTextDisplay.classList.add('hidden');

  if (currentTab === 'image') {
    imageViewerPlaceholder.innerHTML = '<span class="animate-spin inline-block text-base mr-1">sync</span>Loading original page image...';
    imageViewerPlaceholder.classList.remove('hidden');

    // Test if image exists first
    const testImg = new Image();
    testImg.onload = () => {
      imageViewerPlaceholder.classList.add('hidden');
      pageImageDisplay.src = imageApiUrl;
      pageImageDisplay.classList.remove('hidden');
    };
    testImg.onerror = () => {
      imageViewerPlaceholder.textContent = `Original page image not available for page ${imagePageNum}`;
      imageViewerPlaceholder.classList.remove('hidden');
    };
    testImg.src = imageApiUrl;
  } else {
    textViewerPlaceholder.innerHTML = '<span class="animate-spin inline-block text-base mr-1">sync</span>Loading structured content...';
    textViewerPlaceholder.classList.remove('hidden');

    try {
      let url;
      if (activeNodeId) {
        url = `/api/documents/${activeDocId}/nodes/${activeNodeId}/text`;
      } else {
        url = `/api/documents/${activeDocId}/pages/${activePageNum}/text`;
      }
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        textViewerPlaceholder.classList.add('hidden');
        pageTextDisplay.innerHTML = marked.parse(data.content || '');
        pageTextDisplay.classList.remove('hidden');
      } else {
        textViewerPlaceholder.textContent = activeNodeId
          ? `Content not found for section node ${activeNodeId}`
          : `Content not found at page/line index ${activePageNum}`;
        textViewerPlaceholder.classList.remove('hidden');
      }
    } catch (e) {
      textViewerPlaceholder.textContent = `Failed to fetch text: ${e}`;
      textViewerPlaceholder.classList.remove('hidden');
    }
  }
}

// ── Agentic Chat UI & Streaming ─────────────────────────────────────────────
function setupChatUI() {
  sendBtn.addEventListener('click', handleChatSubmit);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleChatSubmit();
    }
  });
}

async function handleChatSubmit() {
  if (selectedChatDocIds.size === 0) {
    showToast("Please select at least one document from the library to chat.", "error");
    return;
  }

  const query = chatInput.value.trim();
  if (!query) return;

  // Clear input
  chatInput.value = '';
  chatInput.style.height = 'auto';

  // Append user message
  appendMessage('user', query);

  // Create AI message container for streaming
  const messageId = `ai-msg-${Date.now()}`;
  const bubbleContainer = appendAIStreamingMessageContainer(messageId);
  const statusContainer = bubbleContainer.querySelector('.reasoning-status-box');
  const deltaTextContainer = bubbleContainer.querySelector('.markdown-body');
  const citationsContainer = bubbleContainer.querySelector('.citations-box');

  // Setup streaming POST payload
  const payload = {
    doc_ids: Array.from(selectedChatDocIds),
    doc_id: Array.from(selectedChatDocIds)[0] || "",
    query: query,
    force_search: false
  };

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Server returned status code: ${response.status}`);
    }

    // Read steam reader
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let accumulatedText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Retain last partial line
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);

          if (data.type === 'status') {
            // Update reasoning steps
            appendReasoningStep(statusContainer, data.content);
          } else if (data.type === 'delta') {
            // Accumulate response text
            accumulatedText += data.content;
            deltaTextContainer.innerHTML = marked.parse(accumulatedText);
            // Auto scroll chat
            chatMessages.scrollTop = chatMessages.scrollHeight;
          } else if (data.type === 'error') {
            appendReasoningStep(statusContainer, `Error: ${data.content}`, true);
          } else if (data.type === 'result') {
            // Stream complete. Render final markdown & citations
            if (accumulatedText) {
              deltaTextContainer.innerHTML = renderCitationsInText(accumulatedText, data.sources);
            }
            renderCitationsFooter(citationsContainer, data.sources, data.fallback);
          }
        } catch (err) {
          console.warn("Error parsing stream line:", line, err);
        }
      }
    }

  } catch (e) {
    loggerErrorBubble(messageId, `Chat execution failed: ${e.message}`);
  }
}

function appendMessage(sender, text) {
  const isAI = sender === 'ai';
  const icon = isAI ? 'chat' : 'person';
  const bgClass = isAI ? 'bg-surface-container' : 'bg-primary text-on-primary';
  const label = isAI ? 'AI ASSISTANT' : 'YOU';

  const html = `
    <div class="flex items-start gap-4 chat-bubble">
      <div class="w-8 h-8 rounded-full ${isAI ? 'bg-primary/10 border border-primary/20' : 'bg-primary/20 border border-primary/40'} flex items-center justify-center shrink-0">
        <span class="material-symbols-outlined text-primary text-lg">${icon}</span>
      </div>
      <div class="space-y-1 max-w-[80%]">
        <div class="text-[10px] text-on-surface-variant font-bold tracking-wider">${label}</div>
        <div class="p-4 rounded-2xl ${bgClass} text-sm leading-relaxed shadow-sm">
          ${isAI ? marked.parse(text) : text.replace(/\n/g, '<br>')}
        </div>
      </div>
    </div>
  `;
  chatMessages.insertAdjacentHTML('beforeend', html);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendAIStreamingMessageContainer(messageId) {
  const html = `
    <div class="flex items-start gap-4 chat-bubble" id="${messageId}">
      <div class="w-8 h-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
        <span class="material-symbols-outlined text-primary text-lg">chat</span>
      </div>
      <div class="space-y-2 max-w-[80%] flex-1">
        <div class="text-[10px] text-on-surface-variant font-bold tracking-wider">AI ASSISTANT</div>
        
        <!-- Reasoning steps logs box -->
        <div class="reasoning-status-box flex flex-col gap-1.5 p-3 rounded-xl bg-outline/5 border border-outline/10 text-[11px] font-medium text-on-surface-variant hidden">
          <!-- Populated in real-time -->
        </div>
        
        <!-- Stream content -->
        <div class="p-4 rounded-2xl bg-surface-container text-sm leading-relaxed shadow-sm">
          <div class="markdown-body prose dark:prose-invert text-sm max-w-none text-on-surface">
            <span class="animate-pulse inline-block w-2 h-4 bg-primary"></span>
          </div>
          
          <!-- Citations list footer -->
          <div class="citations-box flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-outline/10 hidden">
          </div>
        </div>
      </div>
    </div>
  `;
  chatMessages.insertAdjacentHTML('beforeend', html);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return document.getElementById(messageId);
}

function appendReasoningStep(container, stepText, isError = false) {
  container.classList.remove('hidden');
  const icon = isError ? 'error' : 'check_circle';
  const color = isError ? 'text-red-500' : 'text-primary';
  const html = `
    <div class="flex items-center gap-1.5">
      <span class="material-symbols-outlined text-sm shrink-0 ${color}">${icon}</span>
      <span class="truncate">${stepText}</span>
    </div>
  `;
  container.insertAdjacentHTML('beforeend', html);
}

function loggerErrorBubble(messageId, errorMsg) {
  const bubble = document.getElementById(messageId);
  if (bubble) {
    const statusBox = bubble.querySelector('.reasoning-status-box');
    appendReasoningStep(statusBox, errorMsg, true);

    const mdBody = bubble.querySelector('.markdown-body');
    mdBody.innerHTML = `<span class="text-red-500 font-semibold">${errorMsg}</span>`;
  }
}

// ── Interactive Citation Pill Replacement ───────────────────────────────────
function renderCitationsInText(text, sources) {
  if (sources && sources.length > 0) {
    const sourceMap = {};
    sources.forEach(src => {
      if (src.citation_id !== undefined) {
        sourceMap[src.citation_id] = src;
      }
    });

    // Replace [1] with interactive pill for inspectSourceDocument
    text = text.replace(/\[(\d+)\]/g, (match, citationId) => {
      const src = sourceMap[citationId];
      if (src) {
        const isPdf = src.doc_type === 'pdf';
        const label = isPdf ? `p. ${src.page}` : `L ${src.page}`;
        const docNameEscaped = src.doc_name.replace(/'/g, "\\'");
        const docIdEscaped = src.doc_id ? src.doc_id.replace(/'/g, "\\'") : '';
        return `<span class="citation-pill" onclick="inspectSourceDocument('${docNameEscaped}', ${src.page}, '${docIdEscaped}')"><span class="material-symbols-outlined text-[10px]">auto_stories</span>[${citationId}] ${label}</span>`;
      }
      return match;
    });
  } else {
    // Matches references like [Page 4], [4], [L 4], [Line 4] (legacy fallback)
    text = text.replace(/\[(?:Page\s+)?(\d+)\]/gi, (match, pageNum) => {
      return `<span class="citation-pill" onclick="inspectPage(${pageNum})"><span class="material-symbols-outlined text-[10px]">auto_stories</span>Page ${pageNum}</span>`;
    });
    text = text.replace(/\[(?:Line\s+|L\s+)?(\d+)\]/gi, (match, lineNum) => {
      return `<span class="citation-pill" onclick="inspectPage(${lineNum})"><span class="material-symbols-outlined text-[10px]">subject</span>L ${lineNum}</span>`;
    });
  }
  return marked.parse(text);
}

function renderCitationsFooter(container, sources, isFallback) {
  if (!sources || sources.length === 0) {
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');

  // Detect if these are web search sources or document sources
  const isWebSearch = isFallback && sources[0] && sources[0].url !== undefined;

  if (isWebSearch) {
    // Web search fallback sources
    container.innerHTML = `
      <div class="w-full text-[10px] text-on-surface-variant font-bold mb-1.5 flex items-center gap-1">
        <span class="material-symbols-outlined text-xs text-primary">public</span> CITATIONS FROM WEB FALLBACK
      </div>
    ` + sources.map(src => {
      return `
        <a href="${src.url}" target="_blank" class="citation-pill">
          <span class="material-symbols-outlined text-[10px]">link</span> [${src.id}] ${src.title.substring(0, 25)}...
        </a>
      `;
    }).join('');
  } else {
    // Normal document sources
    container.innerHTML = `
      <div class="w-full text-[10px] text-on-surface-variant font-bold mb-1.5 flex items-center gap-1">
        <span class="material-symbols-outlined text-xs text-primary">article</span> REFERENCED OUTLINE PAGES
      </div>
    ` + sources.map(src => {
      const isPdf = src.doc_type === 'pdf';
      const idxLabel = isPdf ? `Page ${src.page}` : `Line ${src.page}`;
      const docNameEscaped = src.doc_name.replace(/'/g, "\\'");
      const docIdEscaped = src.doc_id ? src.doc_id.replace(/'/g, "\\'") : '';
      const citationPrefix = src.citation_id ? `[${src.citation_id}] ` : '';
      return `
        <span onclick="inspectSourceDocument('${docNameEscaped}', ${src.page}, '${docIdEscaped}')" class="citation-pill">
          <span class="material-symbols-outlined text-[10px]">auto_stories</span> ${citationPrefix}${idxLabel} (${src.doc_name.substring(0, 15)}...)
        </span>
      `;
    }).join('');
  }
}

// ── Toast Notifications Helper ──────────────────────────────────────────────
function showToast(message, type = "success") {
  const toastId = `toast-${Date.now()}`;
  const bgClass = type === 'success' ? 'bg-primary text-on-primary' : 'bg-error text-on-primary';
  const icon = type === 'success' ? 'check_circle' : 'error';

  const html = `
    <div id="${toastId}" class="fixed bottom-6 right-6 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg ${bgClass} font-medium text-xs z-50 animate-bounce transition-all duration-300">
      <span class="material-symbols-outlined text-lg">${icon}</span>
      <span>${message}</span>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);

  setTimeout(() => {
    const element = document.getElementById(toastId);
    if (element) {
      element.classList.add('opacity-0', 'translate-y-2');
      setTimeout(() => element.remove(), 300);
    }
  }, 4000);
}

// ── Resizable Split Panes ───────────────────────────────────────────────────
function setupSplitPanes() {
  const leftPanel = document.getElementById('left-panel');
  const leftSplitter = document.getElementById('left-splitter');
  const rightSplitter = document.getElementById('right-splitter');
  const inspectorPanel = document.getElementById('inspector-panel');

  const minLeftWidth = 280;
  const maxLeftWidth = 500;
  const minRightWidth = 300;
  const maxRightWidth = 600;
  const minCenterWidth = 400;

  // Restore widths from localStorage
  const savedLeftWidth = localStorage.getItem('split-left-width');
  const savedRightWidth = localStorage.getItem('split-right-width');

  if (savedLeftWidth && leftPanel) {
    leftPanel.style.width = `${savedLeftWidth}px`;
  }
  if (savedRightWidth && inspectorPanel) {
    inspectorPanel.style.width = `${savedRightWidth}px`;
  }

  // Left splitter drag logic
  if (leftSplitter && leftPanel) {
    leftSplitter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      document.body.style.cursor = 'col-resize';

      const startX = e.clientX;
      const startWidth = leftPanel.offsetWidth;

      function onMouseMove(moveEvent) {
        const currentClientX = moveEvent.clientX;
        window.requestAnimationFrame(() => {
          const deltaX = currentClientX - startX;
          let newWidth = startWidth + deltaX;

          if (newWidth < minLeftWidth) newWidth = minLeftWidth;
          if (newWidth > maxLeftWidth) newWidth = maxLeftWidth;

          // Verify that center panel remains at least minCenterWidth
          const totalWidth = document.body.clientWidth;
          const rightWidth = inspectorPanel ? inspectorPanel.offsetWidth : 0;
          const currentCenterWidth = totalWidth - newWidth - rightWidth - 10;
          if (currentCenterWidth < minCenterWidth) {
            newWidth = totalWidth - rightWidth - minCenterWidth - 10;
            if (newWidth < minLeftWidth) newWidth = minLeftWidth;
          }

          leftPanel.style.width = `${newWidth}px`;
          localStorage.setItem('split-left-width', newWidth);
        });
      }

      function onMouseUp() {
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // Right splitter drag logic
  if (rightSplitter && inspectorPanel) {
    rightSplitter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      document.body.style.cursor = 'col-resize';

      const startX = e.clientX;
      const startWidth = inspectorPanel.offsetWidth;

      function onMouseMove(moveEvent) {
        const currentClientX = moveEvent.clientX;
        window.requestAnimationFrame(() => {
          const deltaX = startX - currentClientX;
          let newWidth = startWidth + deltaX;

          if (newWidth < minRightWidth) newWidth = minRightWidth;
          if (newWidth > maxRightWidth) newWidth = maxRightWidth;

          // Verify that center panel remains at least minCenterWidth
          const totalWidth = document.body.clientWidth;
          const leftWidth = leftPanel ? leftPanel.offsetWidth : 0;
          const currentCenterWidth = totalWidth - leftWidth - newWidth - 10;
          if (currentCenterWidth < minCenterWidth) {
            newWidth = totalWidth - leftWidth - minCenterWidth - 10;
            if (newWidth < minRightWidth) newWidth = minRightWidth;
          }

          inspectorPanel.style.width = `${newWidth}px`;
          localStorage.setItem('split-right-width', newWidth);
        });
      }

      function onMouseUp() {
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // Vertical splitter drag logic for the inspector tree structure
  const inspectorSplitter = document.getElementById('inspector-vertical-splitter');
  const inspectorTreePanel = document.getElementById('inspector-tree-panel');

  const minTreeHeight = 80;
  const savedTreeHeight = localStorage.getItem('inspector-tree-height');
  if (savedTreeHeight && inspectorTreePanel) {
    inspectorTreePanel.style.height = `${savedTreeHeight}px`;
  }

  if (inspectorSplitter && inspectorTreePanel && inspectorPanel) {
    inspectorSplitter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      document.body.style.cursor = 'row-resize';

      const startY = e.clientY;
      const startHeight = inspectorTreePanel.offsetHeight;

      function onMouseMove(moveEvent) {
        const currentClientY = moveEvent.clientY;
        window.requestAnimationFrame(() => {
          const deltaY = currentClientY - startY;
          let newHeight = startHeight + deltaY;

          if (newHeight < minTreeHeight) newHeight = minTreeHeight;
          const maxTreeHeight = inspectorPanel.offsetHeight - 120;
          if (newHeight > maxTreeHeight) newHeight = maxTreeHeight;

          inspectorTreePanel.style.height = `${newHeight}px`;
          localStorage.setItem('inspector-tree-height', newHeight);
        });
      }

      function onMouseUp() {
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }
}

// ── Multi-Document Chat Selection Helpers ────────────────────────────────────
function toggleChatDocument(docId) {
  if (selectedChatDocIds.has(docId)) {
    selectedChatDocIds.delete(docId);
  } else {
    selectedChatDocIds.add(docId);
  }
  renderLibrary();
}

function toggleSelectAll() {
  const selectAllCheckbox = document.getElementById('select-all-checkbox');
  if (!selectAllCheckbox) return;

  const checked = selectAllCheckbox.checked;
  if (checked) {
    documents.forEach(doc => selectedChatDocIds.add(doc.doc_id));
  } else {
    selectedChatDocIds.clear();
  }
  renderLibrary();
}

function setupSelectAllUI() {
  const selectAllContainer = document.getElementById('select-all-container');
  const selectAllCheckbox = document.getElementById('select-all-checkbox');

  if (selectAllContainer && selectAllCheckbox) {
    selectAllContainer.addEventListener('click', (e) => {
      if (e.target !== selectAllCheckbox) {
        selectAllCheckbox.checked = !selectAllCheckbox.checked;
      }
      toggleSelectAll();
    });
  }
}

function updateChatHeader() {
  const activeDocIcon = document.getElementById('active-doc-icon');
  const activeDocTitle = document.getElementById('active-doc-title');
  const activeDocPages = document.getElementById('active-doc-pages');

  if (!activeDocIcon || !activeDocTitle || !activeDocPages) return;

  const selectedCount = selectedChatDocIds.size;
  if (selectedCount === 0) {
    activeDocIcon.textContent = 'chat_bubble_outline';
    activeDocTitle.textContent = 'No documents selected for chat';
    activeDocPages.textContent = '';
  } else if (selectedCount === 1) {
    const docId = Array.from(selectedChatDocIds)[0];
    const doc = documents.find(d => d.doc_id === docId);
    if (doc) {
      let icon = 'draft';
      const ext = doc.doc_name.split('.').pop().toLowerCase();
      if (ext === 'pdf') icon = 'picture_as_pdf';
      else if (ext === 'docx') icon = 'description';
      else if (['png', 'jpg', 'jpeg'].includes(ext)) icon = 'image';
      else if (ext === 'md' || ext === 'markdown') icon = 'markdown';

      activeDocIcon.textContent = icon;
      activeDocTitle.textContent = doc.doc_name;
      activeDocPages.textContent = doc.page_count > 0 ? `(${doc.page_count} pages)` : `(${doc.line_count} lines)`;
    }
  } else {
    activeDocIcon.textContent = 'question_answer';
    activeDocTitle.textContent = `Chatting with ${selectedCount} documents`;

    let totalPages = 0;
    let totalLines = 0;
    selectedChatDocIds.forEach(id => {
      const doc = documents.find(d => d.doc_id === id);
      if (doc) {
        if (doc.page_count > 0) totalPages += doc.page_count;
        else totalLines += doc.line_count;
      }
    });

    if (totalPages > 0) {
      activeDocPages.textContent = `(${totalPages} pages total)`;
    } else {
      activeDocPages.textContent = `(${totalLines} lines total)`;
    }
  }
}

async function inspectSourceDocument(docName, page, docId = null) {
  let doc = null;
  if (docId) {
    doc = documents.find(d => d.doc_id === docId);
  }
  if (!doc) {
    doc = documents.find(d => d.doc_name === docName);
  }
  if (doc) {
    await selectDocument(doc.doc_id);
    inspectPage(page);
  }
}

function toggleDocActionsMenu(event, docId) {
  // Hide all other menus first
  document.querySelectorAll('[id^="actions-menu-"]').forEach(menu => {
    if (menu.id !== `actions-menu-${docId}`) {
      menu.classList.add('hidden');
    }
  });

  const menu = document.getElementById(`actions-menu-${docId}`);
  if (menu) {
    menu.classList.toggle('hidden');

    if (!menu.classList.contains('hidden')) {
      const hideMenu = () => {
        menu.classList.add('hidden');
        document.removeEventListener('click', hideMenu);
      };
      setTimeout(() => {
        document.addEventListener('click', hideMenu);
      }, 50);
    }
  }
}

async function renameDocumentPrompt(docId, oldName) {
  const menu = document.getElementById(`actions-menu-${docId}`);
  if (menu) menu.classList.add('hidden');

  const newName = prompt("Enter new display name for the document:", oldName);
  if (newName === null) return;

  const trimmed = newName.trim();
  if (!trimmed) {
    showToast("Document name cannot be empty.", "error");
    return;
  }

  if (trimmed === oldName) return;

  try {
    const res = await fetch(`/api/documents/${docId}/rename`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_name: trimmed })
    });

    if (res.ok) {
      showToast("Document renamed successfully.", "success");
      await fetchLibrary();
    } else {
      const err = await res.json();
      showToast(`Rename failed: ${err.detail || 'Unknown error'}`, "error");
    }
  } catch (e) {
    showToast(`Error renaming document: ${e.message}`, "error");
  }
}
