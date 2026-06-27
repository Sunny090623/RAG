// State variables
let notebooks = [];
let searchQuery = "";
let sortBy = "recent"; // 'recent' or 'name'

// DOM Elements
const themeToggle = document.getElementById('theme-toggle');
const searchBar = document.getElementById('search-bar');
const sortSelect = document.getElementById('sort-select');
const settingsBtn = document.getElementById('settings-btn');
const createNbBtn = document.getElementById('create-nb-btn');
const emptyCreateBtn = document.getElementById('empty-create-btn');
const createCardWrapper = document.getElementById('create-card-wrapper');
const notebookGrid = document.getElementById('notebook-grid');
const emptyState = document.getElementById('empty-state');

// Dialog elements
const createDialog = document.getElementById('create-dialog');
const createTitleInput = document.getElementById('create-title-input');
const confirmCreateBtn = document.getElementById('confirm-create-btn');

const renameDialog = document.getElementById('rename-dialog');
const renameTitleInput = document.getElementById('rename-title-input');
const renameIdInput = document.getElementById('rename-id-input');
const confirmRenameBtn = document.getElementById('confirm-rename-btn');

const settingsDialog = document.getElementById('settings-dialog');

// Settings Fields (from index.html settings structure)
const settingsProvider = document.getElementById('settings-provider');
const settingsModel = document.getElementById('settings-model');
const settingsBase = document.getElementById('settings-base');
const settingsKey = document.getElementById('settings-key');
const settingsVlmProvider = document.getElementById('settings-vlm-provider');
const settingsVlmModel = document.getElementById('settings-vlm-model');
const settingsVlmBase = document.getElementById('settings-vlm-base');
const settingsVlmKey = document.getElementById('settings-vlm-key');
const saveChatBtn = document.getElementById('save-chat-btn');
const saveVlmBtn = document.getElementById('save-vlm-btn');
const apiKeyContainer = document.getElementById('api-key-container');
const apiBaseContainer = document.getElementById('api-base-container');
const vlmApiKeyContainer = document.getElementById('vlm-api-key-container');
const vlmApiBaseContainer = document.getElementById('vlm-api-base-container');

// Initialize Dashboard
document.addEventListener('DOMContentLoaded', () => {
  setupTheme();
  setupEventListeners();
  setupSettingsUI();
  fetchNotebooks();
  
  // Close context menus on click outside
  document.addEventListener('click', () => {
    document.querySelectorAll('[id^="menu-"]').forEach(menu => {
      menu.classList.add('hidden');
    });
  });
});

// ── Theme Switcher ──────────────────────────────────────────────────────────
function setupTheme() {
  const isDark = localStorage.getItem('theme') !== 'light';
  updateThemeUI(isDark);

  themeToggle.addEventListener('click', () => {
    const isCurrentlyDark = document.documentElement.classList.contains('dark');
    const newDarkState = !isCurrentlyDark;
    localStorage.setItem('theme', newDarkState ? 'dark' : 'light');
    updateThemeUI(newDarkState);
  });
}

function updateThemeUI(isDark) {
  if (isDark) {
    document.documentElement.classList.add('dark');
    themeToggle.innerHTML = '<span class="material-symbols-outlined">light_mode</span>';
  } else {
    document.documentElement.classList.remove('dark');
    themeToggle.innerHTML = '<span class="material-symbols-outlined">dark_mode</span>';
  }
}

// ── Event Listeners ─────────────────────────────────────────────────────────
function setupEventListeners() {
  // Search
  searchBar.addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    renderNotebooks();
  });

  // Sorting
  sortSelect.addEventListener('change', (e) => {
    sortBy = e.target.value;
    renderNotebooks();
  });

  // Settings
  settingsBtn.addEventListener('click', () => {
    fetchSettingsStatus();
    settingsDialog.showModal();
  });

  // Create notebook actions
  const openCreateDialog = () => {
    createTitleInput.value = '';
    createDialog.showModal();
    createTitleInput.focus();
  };

  createNbBtn.addEventListener('click', openCreateDialog);
  if (emptyCreateBtn) emptyCreateBtn.addEventListener('click', openCreateDialog);
  if (createCardWrapper) createCardWrapper.addEventListener('click', openCreateDialog);

  confirmCreateBtn.addEventListener('click', createNotebookSubmit);
  createTitleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createNotebookSubmit();
  });

  // Rename confirmation
  confirmRenameBtn.addEventListener('click', renameNotebookSubmit);
  renameTitleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') renameNotebookSubmit();
  });
}

// ── API Operations ──────────────────────────────────────────────────────────
async function fetchNotebooks() {
  try {
    const res = await fetch('/api/notebooks');
    if (!res.ok) throw new Error("Failed to load notebooks list");
    notebooks = await res.json();
    renderNotebooks();
  } catch (e) {
    showToast(`Error: ${e.message}`, 'error');
  }
}

async function createNotebookSubmit() {
  const title = createTitleInput.value.trim();
  if (!title) {
    showToast('Notebook title cannot be empty', 'error');
    return;
  }

  confirmCreateBtn.disabled = true;
  confirmCreateBtn.textContent = 'Creating...';

  try {
    const res = await fetch('/api/notebooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    if (!res.ok) throw new Error(await res.text());
    const newNb = await res.json();
    showToast(`Notebook "${title}" created successfully!`);
    createDialog.close();
    
    // Navigate to workspace immediately
    openNotebook(newNb.id);
  } catch (e) {
    showToast(`Create failed: ${e.message}`, 'error');
  } finally {
    confirmCreateBtn.disabled = false;
    confirmCreateBtn.textContent = 'Create';
  }
}

async function renameNotebookSubmit() {
  const id = renameIdInput.value;
  const title = renameTitleInput.value.trim();
  if (!title) {
    showToast('Title cannot be empty', 'error');
    return;
  }

  confirmRenameBtn.disabled = true;
  confirmRenameBtn.textContent = 'Renaming...';

  try {
    const res = await fetch(`/api/notebooks/${id}/rename`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    if (!res.ok) throw new Error(await res.text());
    showToast('Notebook renamed successfully');
    renameDialog.close();
    fetchNotebooks();
  } catch (e) {
    showToast(`Rename failed: ${e.message}`, 'error');
  } finally {
    confirmRenameBtn.disabled = false;
    confirmRenameBtn.textContent = 'Rename';
  }
}

async function duplicateNotebook(id) {
  showToast('Duplicating notebook workspace...');
  try {
    const res = await fetch(`/api/notebooks/${id}/duplicate`, { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    showToast('Notebook duplicated successfully!');
    fetchNotebooks();
  } catch (e) {
    showToast(`Duplicate failed: ${e.message}`, 'error');
  }
}

async function deleteNotebook(id, title) {
  if (!confirm(`Are you sure you want to delete the notebook "${title}"? This action CANNOT be undone and will delete all documents and caching associated with it.`)) {
    return;
  }
  
  try {
    const res = await fetch(`/api/notebooks/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    showToast('Notebook deleted successfully');
    fetchNotebooks();
  } catch (e) {
    showToast(`Delete failed: ${e.message}`, 'error');
  }
}

// ── Rendering Grid ──────────────────────────────────────────────────────────
function renderNotebooks() {
  // Filter
  let filtered = notebooks.filter(nb => nb.title.toLowerCase().includes(searchQuery));

  // Sort
  if (sortBy === 'name') {
    filtered.sort((a, b) => a.title.localeCompare(b.title));
  } else {
    filtered.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  }

  // Clear grid keep create card
  const cards = Array.from(notebookGrid.children).filter(el => el.id !== 'create-card-wrapper');
  cards.forEach(el => el.remove());

  if (notebooks.length === 0) {
    emptyState.classList.remove('hidden');
    emptyState.classList.add('flex');
    createCardWrapper.classList.add('hidden');
  } else {
    emptyState.classList.add('hidden');
    emptyState.classList.remove('flex');
    createCardWrapper.classList.remove('hidden');
    
    // Hash to assign a stable cover color gradient based on ID
    const getGradIndex = (id) => {
      let hash = 0;
      for (let i = 0; i < id.length; i++) {
        hash = id.charCodeAt(i) + ((hash << 5) - hash);
      }
      return Math.abs(hash) % 5;
    };

    filtered.forEach(nb => {
      const gradIdx = getGradIndex(nb.id);
      const docCountText = nb.doc_count === 1 ? '1 document' : `${nb.doc_count || 0} documents`;
      const dateText = formatDate(nb.updated_at);
      const escapedTitle = nb.title.replace(/'/g, "\\'").replace(/"/g, '&quot;');

      const cardHtml = `
        <div class="bg-surface-container/40 border border-outline/10 rounded-2xl overflow-hidden hover:shadow-lg transition-all duration-300 group flex flex-col cursor-pointer relative" onclick="openNotebook('${nb.id}')">
          <!-- colored cover header -->
          <div class="h-28 cover-grad-${gradIdx} relative flex items-end p-4">
            <span class="material-symbols-outlined text-white text-3xl font-bold opacity-80 group-hover:scale-110 transition-transform duration-300">book</span>
          </div>
          <!-- info -->
          <div class="p-4 flex-1 flex flex-col justify-between">
            <div class="min-w-0">
              <h3 class="text-xs font-bold text-on-surface truncate pr-6" title="${nb.title}">${nb.title}</h3>
              <p class="text-[10px] text-on-surface-variant/80 mt-1">${docCountText}</p>
            </div>
            <div class="flex items-center justify-between mt-4">
              <span class="text-[9px] text-on-surface-variant font-medium">Modified ${dateText}</span>
              <div class="relative" onclick="event.stopPropagation()">
                <button onclick="toggleCardMenu(event, '${nb.id}')" class="p-1 rounded-lg hover:bg-outline/15 text-on-surface-variant hover:text-primary transition-colors">
                  <span class="material-symbols-outlined text-base">more_vert</span>
                </button>
                <!-- Menu -->
                <div id="menu-${nb.id}" class="hidden absolute right-0 bottom-8 w-32 bg-surface-container-high border border-outline/15 rounded-xl shadow-xl z-50 flex flex-col py-1 text-xs text-on-surface">
                  <button onclick="renameNotebookPrompt(event, '${nb.id}', '${escapedTitle}')" class="flex items-center gap-2 px-3 py-2 hover:bg-outline/10 text-on-surface text-left transition-colors font-medium">
                    <span class="material-symbols-outlined text-sm">edit</span> Rename
                  </button>
                  <button onclick="duplicateNotebook('${nb.id}')" class="flex items-center gap-2 px-3 py-2 hover:bg-outline/10 text-on-surface text-left transition-colors font-medium">
                    <span class="material-symbols-outlined text-sm">content_copy</span> Duplicate
                  </button>
                  <hr class="border-outline/10 my-1">
                  <button onclick="deleteNotebook('${nb.id}', '${escapedTitle}')" class="flex items-center gap-2 px-3 py-2 hover:bg-red-500/10 text-red-500 hover:text-red-600 text-left transition-colors font-medium">
                    <span class="material-symbols-outlined text-sm">delete</span> Delete
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
      notebookGrid.insertAdjacentHTML('beforeend', cardHtml);
    });
  }
}

function openNotebook(id) {
  window.location.href = `/workspace/${id}`;
}

function toggleCardMenu(event, id) {
  event.stopPropagation();
  // Hide all other menus
  document.querySelectorAll('[id^="menu-"]').forEach(menu => {
    if (menu.id !== `menu-${id}`) menu.classList.add('hidden');
  });

  const menu = document.getElementById(`menu-${id}`);
  if (menu) {
    menu.classList.toggle('hidden');
  }
}

function renameNotebookPrompt(event, id, currentTitle) {
  event.stopPropagation();
  renameIdInput.value = id;
  renameTitleInput.value = currentTitle;
  renameDialog.showModal();
  renameTitleInput.focus();
  
  // Close context menu
  document.getElementById(`menu-${id}`).classList.add('hidden');
}

// ── Global Settings Logic (Copied behavior from index.js) ───────────────────
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

  saveChatBtn.addEventListener('click', saveChatSettings);
  saveVlmBtn.addEventListener('click', saveVlmSettings);
}

async function fetchSettingsStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    settingsProvider.value = data.active_provider.provider_type;
    settingsProvider.dispatchEvent(new Event('change'));

    settingsModel.value = data.active_provider.model_name;
    settingsBase.value = data.active_provider.api_base || '';
    if (data.active_provider.api_key) {
      settingsKey.value = data.active_provider.api_key;
    }

    settingsVlmProvider.value = data.vlm_provider.provider_type || 'ollama';
    settingsVlmProvider.dispatchEvent(new Event('change'));

    settingsVlmModel.value = data.vlm_provider.model_name || '';
    settingsVlmBase.value = data.vlm_provider.api_base || '';
    if (data.vlm_provider.api_key) {
      settingsVlmKey.value = data.vlm_provider.api_key;
    }
  } catch (e) {
    console.error("Failed to query settings status", e);
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
      showToast("Chat settings saved successfully!");
    } else {
      const err = await res.json();
      showToast(`Failed to update Chat settings: ${err.detail}`, "error");
    }
  } catch (e) {
    showToast(`Error updating Chat settings: ${e.message}`, "error");
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
      showToast("VLM settings saved successfully!");
    } else {
      const err = await res.json();
      showToast(`Failed to update VLM settings: ${err.detail}`, "error");
    }
  } catch (e) {
    showToast(`Error updating VLM settings: ${e.message}`, "error");
  } finally {
    saveVlmBtn.disabled = false;
    saveVlmBtn.innerHTML = '<span class="material-symbols-outlined text-sm">save</span> Save VLM Settings';
  }
}

// ── Toast Helper ────────────────────────────────────────────────────────────
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

// ── Date Formatting ──────────────────────────────────────────────────────────
function formatDate(isoString) {
  if (!isoString) return 'unknown';
  try {
    const date = new Date(isoString);
    const options = { month: 'short', day: 'numeric', year: 'numeric' };
    return date.toLocaleDateString('en-US', options);
  } catch (e) {
    return 'unknown';
  }
}
