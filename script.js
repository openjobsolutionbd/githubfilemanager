(function() {
    // -------------------- DOM references --------------------
    const tokenInput = document.getElementById('tokenInput');
    const connectBtn = document.getElementById('connectBtn');
    const disconnectBtn = document.getElementById('disconnectBtn');
    const repoSelect = document.getElementById('repoSelect');
    const branchSelect = document.getElementById('branchSelect');
    const fileTree = document.getElementById('fileTree');
    const tabBar = document.getElementById('tabBar');
    const codeEditor = document.getElementById('codeEditor');
    const editorWrapper = document.getElementById('editorWrapper');
    const mdPreview = document.getElementById('mdPreview');
    const imagePreview = document.getElementById('imagePreview');
    const binaryNotice = document.getElementById('binaryNotice');
    const noFileMessage = document.getElementById('noFileMessage');
    const filePathDisplay = document.getElementById('filePathDisplay');
    const fileSizeDisplay = document.getElementById('fileSizeDisplay');
    const saveFileBtn = document.getElementById('saveFileBtn');
    const deleteFileBtn = document.getElementById('deleteFileBtn');
    const copyContentBtn = document.getElementById('copyContentBtn');
    const historyBtn = document.getElementById('historyBtn');
    const mdPreviewBtn = document.getElementById('mdPreviewBtn');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const toastContainer = document.getElementById('toastContainer');
    const modalOverlay = document.getElementById('modalOverlay');
    const modalContent = document.getElementById('modalContent');
    const newFileBtn = document.getElementById('newFileBtn');
    const newFolderBtn = document.getElementById('newFolderBtn');
    const refreshTreeBtn = document.getElementById('refreshTreeBtn');
    const collapseAllBtn = document.getElementById('collapseAllBtn');
    const themeToggle = document.getElementById('themeToggle');
    const dropZone = document.getElementById('dropZone');

    // -------------------- State --------------------
    let githubToken = '';
    let currentRepo = null;      // "owner/name"
    let currentBranch = 'main';
    let openTabs = new Map();    // path -> { content, sha, originalContent, isNew, isBinary, isImage }
    let activeTabPath = null;
    let fileTreeCache = new Map(); // dirPath -> array of entries
    let expandedDirs = new Set();
    let cmInstance = null;
    let currentTheme = 'dark';
    let mdPreviewOn = false;

    const API_BASE = 'https://api.github.com';

    // -------------------- PWA & Service Worker --------------------
    let newWorker = null;

    function showUpdateToast() {
        const t = document.createElement('div');
        t.className = 'toast info';
        t.innerHTML = '<span>🔄</span> New version available! <button class="btn small" id="updateAppBtn">Update</button>';
        toastContainer.appendChild(t);
        document.getElementById('updateAppBtn').addEventListener('click', () => {
            if (newWorker) newWorker.postMessage({ type: 'SKIP_WAITING' });
            t.remove();
        });
        setTimeout(() => t.remove(), 10000);
    }

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js')
            .then(reg => {
                console.log('Service Worker registered with scope:', reg.scope);
                reg.addEventListener('updatefound', () => {
                    const installing = reg.installing;
                    installing.addEventListener('statechange', () => {
                        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                            newWorker = reg.waiting;
                            showUpdateToast();
                        }
                    });
                });
                if (reg.waiting && navigator.serviceWorker.controller) {
                    newWorker = reg.waiting;
                    showUpdateToast();
                }
            })
            .catch(err => console.log('SW registration failed:', err));

        navigator.serviceWorker.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'RELOAD') {
                window.location.reload();
            }
        });
    }

    // -------------------- Toast helper --------------------
    function toast(msg, type = 'info') {
        const t = document.createElement('div');
        t.className = `toast ${type}`;
        t.innerHTML = `<span>${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span> ${msg}`;
        toastContainer.appendChild(t);
        setTimeout(() => { t.style.animation = 'fadeOut 0.3s forwards'; setTimeout(() => t.remove(), 300); }, 2800);
    }

    // -------------------- Modal helper --------------------
    function showModal(html, onMount) {
        modalContent.innerHTML = html;
        modalOverlay.style.display = 'flex';
        if (onMount) onMount(modalContent);
        const escHandler = (e) => { if (e.key === 'Escape') closeModal(); };
        document.addEventListener('keydown', escHandler);
        modalOverlay._escHandler = escHandler;
    }
    function closeModal() {
        modalOverlay.style.display = 'none';
        modalContent.innerHTML = '';
        if (modalOverlay._escHandler) document.removeEventListener('keydown', modalOverlay._escHandler);
    }
    modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

    function confirmModal(title, message, confirmLabel = 'Confirm', danger = false) {
        return new Promise((resolve) => {
            showModal(`
                <h3>${title}</h3>
                <p>${message}</p>
                <div class="modal-actions">
                    <button id="modalCancelBtn">Cancel</button>
                    <button class="${danger ? 'danger-btn' : 'confirm-btn'}" id="modalConfirmBtn">${confirmLabel}</button>
                </div>
            `, (root) => {
                root.querySelector('#modalCancelBtn').addEventListener('click', () => { closeModal(); resolve(false); });
                root.querySelector('#modalConfirmBtn').addEventListener('click', () => { closeModal(); resolve(true); });
            });
        });
    }

    function promptModal(title, message, placeholder = '', defaultValue = '') {
        return new Promise((resolve) => {
            showModal(`
                <h3>${title}</h3>
                <p>${message}</p>
                <input type="text" id="modalPromptInput" placeholder="${placeholder}" value="${defaultValue}">
                <div class="modal-actions">
                    <button id="modalCancelBtn">Cancel</button>
                    <button class="confirm-btn" id="modalConfirmBtn">OK</button>
                </div>
            `, (root) => {
                const input = root.querySelector('#modalPromptInput');
                input.focus();
                input.select();
                const submit = () => { const v = input.value.trim(); closeModal(); resolve(v || null); };
                input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
                root.querySelector('#modalCancelBtn').addEventListener('click', () => { closeModal(); resolve(null); });
                root.querySelector('#modalConfirmBtn').addEventListener('click', submit);
            });
        });
    }

    // -------------------- GitHub API helpers --------------------
    async function ghFetch(path, options = {}) {
        const res = await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                'Authorization': `token ${githubToken}`,
                'Accept': 'application/vnd.github+json',
                ...(options.headers || {})
            }
        });
        if (!res.ok) {
            let msg = res.statusText;
            try { const j = await res.json(); if (j.message) msg = j.message; } catch (e) {}
            throw new Error(`${res.status}: ${msg}`);
        }
        if (res.status === 204) return null;
        return res.json();
    }

    function b64EncodeUnicode(str) {
        return btoa(unescape(encodeURIComponent(str)));
    }
    function b64DecodeUnicode(str) {
        return decodeURIComponent(escape(atob(str)));
    }

    // -------------------- Connection --------------------
    async function connect() {
        const token = tokenInput.value.trim();
        if (!token) { toast('Please enter a GitHub token', 'error'); return; }
        githubToken = token;
        connectBtn.disabled = true;
        connectBtn.textContent = 'Connecting...';
        try {
            const user = await ghFetch('/user');
            statusDot.classList.add('on');
            statusText.textContent = `Connected as ${user.login}`;
            disconnectBtn.style.display = '';
            connectBtn.style.display = 'none';
            tokenInput.style.display = 'none';
            localStorage.setItem('gh_fm_token', token);
            await loadRepos();
            newFileBtn.disabled = false;
            newFolderBtn.disabled = false;
            refreshTreeBtn.disabled = false;
            toast('Connected to GitHub', 'success');
        } catch (err) {
            toast(`Connection failed: ${err.message}`, 'error');
            githubToken = '';
        } finally {
            connectBtn.disabled = false;
            connectBtn.textContent = 'Connect';
        }
    }

    function disconnect() {
        githubToken = '';
        currentRepo = null;
        openTabs.clear();
        activeTabPath = null;
        fileTreeCache.clear();
        expandedDirs.clear();
        localStorage.removeItem('gh_fm_token');
        statusDot.classList.remove('on');
        statusText.textContent = 'Not connected';
        disconnectBtn.style.display = 'none';
        connectBtn.style.display = '';
        tokenInput.style.display = '';
        tokenInput.value = '';
        repoSelect.innerHTML = '<option value="">Select repo</option>';
        repoSelect.disabled = true;
        branchSelect.innerHTML = '<option value="">Branch</option>';
        branchSelect.disabled = true;
        newFileBtn.disabled = true;
        newFolderBtn.disabled = true;
        saveFileBtn.disabled = true;
        deleteFileBtn.disabled = true;
        copyContentBtn.disabled = true;
        historyBtn.disabled = true;
        mdPreviewBtn.disabled = true;
        renderTabs();
        showPlaceholder();
        fileTree.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);"><div style="font-size:28px;">📭</div><div>Connect a repository</div></div>';
        toast('Disconnected', 'info');
    }

    async function loadRepos() {
        repoSelect.disabled = true;
        repoSelect.innerHTML = '<option value="">Loading...</option>';
        try {
            let repos = [];
            let page = 1;
            while (true) {
                const batch = await ghFetch(`/user/repos?per_page=100&page=${page}&sort=updated`);
                repos = repos.concat(batch);
                if (batch.length < 100) break;
                page++;
                if (page > 5) break; // safety cap
            }
            repoSelect.innerHTML = '<option value="">Select repo</option>' +
                repos.map(r => `<option value="${r.full_name}" data-default-branch="${r.default_branch}">${r.full_name}</option>`).join('');
            repoSelect.disabled = false;
        } catch (err) {
            toast(`Failed to load repos: ${err.message}`, 'error');
            repoSelect.innerHTML = '<option value="">Select repo</option>';
        }
    }

    async function onRepoChange() {
        const val = repoSelect.value;
        if (!val) { branchSelect.disabled = true; branchSelect.innerHTML = '<option value="">Branch</option>'; return; }
        currentRepo = val;
        const selectedOption = repoSelect.options[repoSelect.selectedIndex];
        const defaultBranch = selectedOption.getAttribute('data-default-branch') || 'main';
        openTabs.clear();
        activeTabPath = null;
        renderTabs();
        showPlaceholder();
        fileTreeCache.clear();
        expandedDirs.clear();
        branchSelect.disabled = true;
        branchSelect.innerHTML = '<option value="">Loading...</option>';
        try {
            const branches = await ghFetch(`/repos/${currentRepo}/branches?per_page=100`);
            branchSelect.innerHTML = branches.map(b =>
                `<option value="${b.name}" ${b.name === defaultBranch ? 'selected' : ''}>${b.name}</option>`
            ).join('');
            branchSelect.disabled = false;
            currentBranch = branchSelect.value || defaultBranch;
            await loadRootTree();
        } catch (err) {
            toast(`Failed to load branches: ${err.message}`, 'error');
        }
    }

    async function onBranchChange() {
        currentBranch = branchSelect.value;
        openTabs.clear();
        activeTabPath = null;
        renderTabs();
        showPlaceholder();
        fileTreeCache.clear();
        expandedDirs.clear();
        await loadRootTree();
    }

    // -------------------- File tree --------------------
    async function fetchDirContents(path) {
        const cacheKey = path || '/';
        if (fileTreeCache.has(cacheKey)) return fileTreeCache.get(cacheKey);
        const encodedPath = path ? path.split('/').map(encodeURIComponent).join('/') : '';
        const data = await ghFetch(`/repos/${currentRepo}/contents/${encodedPath}?ref=${encodeURIComponent(currentBranch)}`);
        const entries = Array.isArray(data) ? data : [data];
        entries.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        fileTreeCache.set(cacheKey, entries);
        return entries;
    }

    async function loadRootTree() {
        fileTree.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">Loading...</div>';
        try {
            const entries = await fetchDirContents('');
            fileTree.innerHTML = '';
            renderTreeLevel(entries, fileTree, 0);
        } catch (err) {
            fileTree.innerHTML = `<div style="padding:20px;text-align:center;color:var(--red);">Failed to load: ${err.message}</div>`;
        }
    }

    function iconFor(entry) {
        if (entry.type === 'dir') return '📁';
        const ext = entry.name.split('.').pop().toLowerCase();
        const map = {
            js: '📜', ts: '📜', jsx: '📜', tsx: '📜', json: '🧾', md: '📝', markdown: '📝',
            html: '🌐', css: '🎨', py: '🐍', yml: '⚙️', yaml: '⚙️', sh: '💻', sql: '🗄️',
            png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
            txt: '📄', pdf: '📕', lock: '🔒'
        };
        return map[ext] || '📄';
    }

    function renderTreeLevel(entries, container, depth) {
        entries.forEach(entry => {
            const item = document.createElement('div');
            item.className = `tree-item ${entry.type === 'dir' ? 'directory' : 'file'}`;
            item.style.paddingLeft = `${10 + depth * 16}px`;
            item.dataset.path = entry.path;
            item.innerHTML = `
                <span class="chevron">${entry.type === 'dir' ? '▶' : ''}</span>
                <span class="icon">${iconFor(entry)}</span>
                <span class="name">${entry.name}</span>
                <span class="delete-icon" title="Delete">🗑</span>
            `;
            container.appendChild(item);

            if (entry.type === 'dir') {
                const childrenContainer = document.createElement('div');
                childrenContainer.className = 'children collapsed';
                container.appendChild(childrenContainer);

                item.addEventListener('click', async (e) => {
                    if (e.target.classList.contains('delete-icon')) return;
                    const isExpanded = expandedDirs.has(entry.path);
                    if (isExpanded) {
                        expandedDirs.delete(entry.path);
                        item.classList.remove('expanded');
                        childrenContainer.classList.add('collapsed');
                    } else {
                        expandedDirs.add(entry.path);
                        item.classList.add('expanded');
                        childrenContainer.classList.remove('collapsed');
                        if (!childrenContainer.hasChildNodes()) {
                            try {
                                const subEntries = await fetchDirContents(entry.path);
                                renderTreeLevel(subEntries, childrenContainer, depth + 1);
                            } catch (err) {
                                toast(`Failed to load folder: ${err.message}`, 'error');
                            }
                        }
                    }
                });
            } else {
                item.addEventListener('click', (e) => {
                    if (e.target.classList.contains('delete-icon')) return;
                    openFile(entry.path);
                });
            }

            item.querySelector('.delete-icon').addEventListener('click', async (e) => {
                e.stopPropagation();
                await deleteEntry(entry);
            });
        });
    }

    async function refreshTree() {
        fileTreeCache.clear();
        const previouslyExpanded = new Set(expandedDirs);
        expandedDirs.clear();
        await loadRootTree();
        // Re-expand previously expanded dirs (best-effort, top-level only re-render triggers lazy loads)
        for (const dir of previouslyExpanded) {
            const el = fileTree.querySelector(`.tree-item[data-path="${CSS.escape(dir)}"]`);
            if (el) el.click();
        }
        toast('File tree refreshed', 'success');
    }

    function collapseAll() {
        expandedDirs.clear();
        fileTree.querySelectorAll('.tree-item.directory').forEach(el => el.classList.remove('expanded'));
        fileTree.querySelectorAll('.children').forEach(el => el.classList.add('collapsed'));
    }

    // -------------------- File type helpers --------------------
    const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'];
    const BINARY_EXT = ['zip', 'pdf', 'ttf', 'woff', 'woff2', 'eot', 'exe', 'dll', 'so', 'bin', 'mp3', 'mp4', 'mov', 'avi'];

    function getExt(path) {
        const parts = path.split('.');
        return parts.length > 1 ? parts.pop().toLowerCase() : '';
    }
    function isImagePath(path) { return IMAGE_EXT.includes(getExt(path)); }
    function isBinaryPath(path) { return BINARY_EXT.includes(getExt(path)); }
    function isMarkdownPath(path) { return ['md', 'markdown'].includes(getExt(path)); }

    function modeForPath(path) {
        const ext = getExt(path);
        const modeMap = {
            js: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript',
            py: 'python', html: 'htmlmixed', htm: 'htmlmixed', xml: 'xml',
            css: 'css', md: 'markdown', markdown: 'markdown',
            java: 'clike', c: 'clike', cpp: 'clike', cs: 'clike',
            sh: 'shell', bash: 'shell', yml: 'yaml', yaml: 'yaml', sql: 'sql',
            json: { name: 'javascript', json: true }
        };
        return modeMap[ext] || 'null';
    }

    // -------------------- Tabs --------------------
    function renderTabs() {
        tabBar.innerHTML = '';
        for (const [path, tab] of openTabs.entries()) {
            const el = document.createElement('div');
            el.className = `tab ${path === activeTabPath ? 'active' : ''}`;
            const name = path.split('/').pop();
            const modified = tab.content !== tab.originalContent;
            el.innerHTML = `
                ${modified ? '<span class="modified-dot"></span>' : ''}
                <span class="tab-name">${name}</span>
                <button class="close-tab" title="Close">×</button>
            `;
            el.addEventListener('click', (e) => {
                if (e.target.classList.contains('close-tab')) return;
                switchToTab(path);
            });
            el.querySelector('.close-tab').addEventListener('click', async (e) => {
                e.stopPropagation();
                await closeTab(path);
            });
            tabBar.appendChild(el);
        }
    }

    async function closeTab(path) {
        const tab = openTabs.get(path);
        if (tab && tab.content !== tab.originalContent) {
            const ok = await confirmModal('Unsaved changes', `"${path.split('/').pop()}" has unsaved changes. Close anyway?`, 'Close', true);
            if (!ok) return;
        }
        openTabs.delete(path);
        if (activeTabPath === path) {
            const remaining = Array.from(openTabs.keys());
            activeTabPath = remaining.length ? remaining[remaining.length - 1] : null;
            if (activeTabPath) switchToTab(activeTabPath);
            else showPlaceholder();
        }
        renderTabs();
    }

    function showPlaceholder() {
        noFileMessage.style.display = '';
        editorWrapper.style.display = 'none';
        mdPreview.style.display = 'none';
        imagePreview.style.display = 'none';
        binaryNotice.style.display = 'none';
        filePathDisplay.textContent = 'No file open';
        fileSizeDisplay.textContent = '';
        saveFileBtn.disabled = true;
        deleteFileBtn.disabled = true;
        copyContentBtn.disabled = true;
        historyBtn.disabled = true;
        mdPreviewBtn.style.display = 'none';
        mdPreviewBtn.disabled = true;
    }

    function switchToTab(path) {
        activeTabPath = path;
        const tab = openTabs.get(path);
        if (!tab) { showPlaceholder(); return; }
        renderTabs();
        filePathDisplay.textContent = path;
        fileSizeDisplay.textContent = tab.size != null ? formatSize(tab.size) : '';
        saveFileBtn.disabled = false;
        deleteFileBtn.disabled = false;
        copyContentBtn.disabled = false;
        historyBtn.disabled = false;

        noFileMessage.style.display = 'none';
        mdPreview.style.display = 'none';
        imagePreview.style.display = 'none';
        binaryNotice.style.display = 'none';
        editorWrapper.style.display = 'none';
        mdPreviewOn = false;

        if (tab.isImage) {
            imagePreview.style.display = 'flex';
            imagePreview.innerHTML = `<img src="${tab.dataUrl}" alt="${path}">`;
            mdPreviewBtn.style.display = 'none';
            mdPreviewBtn.disabled = true;
        } else if (tab.isBinary) {
            binaryNotice.style.display = 'flex';
            mdPreviewBtn.style.display = 'none';
            mdPreviewBtn.disabled = true;
        } else {
            editorWrapper.style.display = 'flex';
            mountEditor(tab);
            if (isMarkdownPath(path)) {
                mdPreviewBtn.style.display = '';
                mdPreviewBtn.disabled = false;
            } else {
                mdPreviewBtn.style.display = 'none';
                mdPreviewBtn.disabled = true;
            }
        }
    }

    function mountEditor(tab) {
        codeEditor.style.display = '';
        if (!cmInstance) {
            cmInstance = CodeMirror.fromTextArea(codeEditor, {
                lineNumbers: true,
                mode: modeForPath(activeTabPath),
                theme: currentTheme === 'dark' ? 'dracula' : 'default',
                indentUnit: 4,
                tabSize: 4,
                lineWrapping: true,
                matchBrackets: true,
                autoCloseBrackets: true
            });
            cmInstance.on('change', () => {
                const tab = openTabs.get(activeTabPath);
                if (!tab) return;
                tab.content = cmInstance.getValue();
                renderTabs();
            });
        } else {
            cmInstance.setOption('mode', modeForPath(activeTabPath));
        }
        cmInstance.setValue(tab.content || '');
        setTimeout(() => cmInstance.refresh(), 10);
    }

    function formatSize(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    // -------------------- Open / New / Save / Delete --------------------
    async function openFile(path) {
        if (openTabs.has(path)) { switchToTab(path); return; }
        try {
            toast(`Opening ${path.split('/').pop()}...`, 'info');
            const data = await ghFetch(`/repos/${currentRepo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(currentBranch)}`);
            const tab = { sha: data.sha, size: data.size, isNew: false };

            if (isImagePath(path)) {
                tab.isImage = true;
                tab.dataUrl = `data:image/${getExt(path) === 'svg' ? 'svg+xml' : getExt(path)};base64,${data.content.replace(/\n/g, '')}`;
                tab.content = '';
                tab.originalContent = '';
            } else if (isBinaryPath(path)) {
                tab.isBinary = true;
                tab.content = '';
                tab.originalContent = '';
            } else {
                const decoded = b64DecodeUnicode(data.content.replace(/\n/g, ''));
                tab.content = decoded;
                tab.originalContent = decoded;
            }
            openTabs.set(path, tab);
            switchToTab(path);
        } catch (err) {
            toast(`Failed to open file: ${err.message}`, 'error');
        }
    }

    async function newFile() {
        if (!currentRepo) { toast('Select a repository first', 'error'); return; }
        const name = await promptModal('New File', 'Enter file path (e.g. src/index.js)', 'path/to/file.txt');
        if (!name) return;
        if (openTabs.has(name)) { toast('File already open', 'error'); switchToTab(name); return; }
        openTabs.set(name, { content: '', originalContent: null, sha: null, isNew: true, size: 0 });
        switchToTab(name);
        toast('New file created (unsaved)', 'info');
    }

    async function newFolder() {
        if (!currentRepo) { toast('Select a repository first', 'error'); return; }
        const name = await promptModal('New Folder', 'Enter folder path (e.g. src/components)', 'path/to/folder');
        if (!name) return;
        const gitkeepPath = `${name.replace(/\/$/, '')}/.gitkeep`;
        try {
            await ghFetch(`/repos/${currentRepo}/contents/${gitkeepPath.split('/').map(encodeURIComponent).join('/')}`, {
                method: 'PUT',
                body: JSON.stringify({
                    message: `Create folder ${name}`,
                    content: b64EncodeUnicode(''),
                    branch: currentBranch
                })
            });
            toast(`Folder "${name}" created`, 'success');
            fileTreeCache.clear();
            await loadRootTree();
        } catch (err) {
            toast(`Failed to create folder: ${err.message}`, 'error');
        }
    }

    async function saveFile() {
        if (!activeTabPath) return;
        const tab = openTabs.get(activeTabPath);
        if (!tab || tab.isBinary || tab.isImage) { toast('Cannot save this file type', 'error'); return; }
        saveFileBtn.disabled = true;
        try {
            const body = {
                message: tab.isNew ? `Create ${activeTabPath}` : `Update ${activeTabPath}`,
                content: b64EncodeUnicode(tab.content),
                branch: currentBranch
            };
            if (!tab.isNew && tab.sha) body.sha = tab.sha;

            const encodedPath = activeTabPath.split('/').map(encodeURIComponent).join('/');
            const result = await ghFetch(`/repos/${currentRepo}/contents/${encodedPath}`, {
                method: 'PUT',
                body: JSON.stringify(body)
            });
            tab.sha = result.content.sha;
            tab.originalContent = tab.content;
            tab.isNew = false;
            tab.size = result.content.size;
            renderTabs();
            fileSizeDisplay.textContent = formatSize(tab.size);
            toast('File saved', 'success');
            fileTreeCache.clear();
            await loadRootTree();
        } catch (err) {
            toast(`Failed to save: ${err.message}`, 'error');
        } finally {
            saveFileBtn.disabled = false;
        }
    }

    async function deleteEntry(entry) {
        const ok = await confirmModal(
            `Delete ${entry.type === 'dir' ? 'folder' : 'file'}`,
            `Are you sure you want to delete "${entry.path}"? This cannot be undone.`,
            'Delete',
            true
        );
        if (!ok) return;
        try {
            if (entry.type === 'dir') {
                // Recursively delete all files within the folder
                await deleteFolderRecursive(entry.path);
            } else {
                await ghFetch(`/repos/${currentRepo}/contents/${entry.path.split('/').map(encodeURIComponent).join('/')}`, {
                    method: 'DELETE',
                    body: JSON.stringify({
                        message: `Delete ${entry.path}`,
                        sha: entry.sha,
                        branch: currentBranch
                    })
                });
            }
            if (openTabs.has(entry.path)) { openTabs.delete(entry.path); if (activeTabPath === entry.path) activeTabPath = null; renderTabs(); showPlaceholder(); }
            toast(`Deleted "${entry.path}"`, 'success');
            fileTreeCache.clear();
            await loadRootTree();
        } catch (err) {
            toast(`Failed to delete: ${err.message}`, 'error');
        }
    }

    async function deleteFolderRecursive(path) {
        const entries = await fetchDirContents(path);
        for (const entry of entries) {
            if (entry.type === 'dir') {
                await deleteFolderRecursive(entry.path);
            } else {
                await ghFetch(`/repos/${currentRepo}/contents/${entry.path.split('/').map(encodeURIComponent).join('/')}`, {
                    method: 'DELETE',
                    body: JSON.stringify({
                        message: `Delete ${entry.path}`,
                        sha: entry.sha,
                        branch: currentBranch
                    })
                });
            }
        }
    }

    async function deleteActiveFile() {
        if (!activeTabPath) return;
        const tab = openTabs.get(activeTabPath);
        if (tab.isNew) {
            openTabs.delete(activeTabPath);
            const remaining = Array.from(openTabs.keys());
            activeTabPath = remaining.length ? remaining[remaining.length - 1] : null;
            renderTabs();
            if (activeTabPath) switchToTab(activeTabPath); else showPlaceholder();
            return;
        }
        await deleteEntry({ path: activeTabPath, sha: tab.sha, type: 'file' });
    }

    // -------------------- Copy / History --------------------
    async function copyContent() {
        if (!activeTabPath) return;
        const tab = openTabs.get(activeTabPath);
        try {
            await navigator.clipboard.writeText(tab.content || '');
            toast('Copied to clipboard', 'success');
        } catch (err) {
            toast('Copy failed', 'error');
        }
    }

    async function showHistory() {
        if (!activeTabPath || !currentRepo) return;
        try {
            const commits = await ghFetch(`/repos/${currentRepo}/commits?path=${encodeURIComponent(activeTabPath)}&sha=${encodeURIComponent(currentBranch)}&per_page=20`);
            const listHtml = commits.map(c => `
                <div class="history-item" data-sha="${c.sha}">
                    <div style="font-weight:600;">${(c.commit.message || '').split('\n')[0]}</div>
                    <div style="font-size:11px;color:var(--text-muted);">${c.commit.author.name} · ${new Date(c.commit.author.date).toLocaleString()} · ${c.sha.slice(0, 7)}</div>
                </div>
            `).join('') || '<p>No history found.</p>';
            showModal(`
                <h3>History — ${activeTabPath.split('/').pop()}</h3>
                <div class="history-modal-content">${listHtml}</div>
                <div class="modal-actions"><button id="modalCloseBtn">Close</button></div>
            `, (root) => {
                root.querySelector('#modalCloseBtn').addEventListener('click', closeModal);
                root.querySelectorAll('.history-item').forEach(el => {
                    el.addEventListener('click', async () => {
                        const sha = el.dataset.sha;
                        try {
                            const data = await ghFetch(`/repos/${currentRepo}/contents/${activeTabPath.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`);
                            const decoded = b64DecodeUnicode(data.content.replace(/\n/g, ''));
                            closeModal();
                            const ok = await confirmModal('Load old version', 'This will replace the current editor content with this historical version (not saved yet). Continue?', 'Load');
                            if (ok) {
                                const tab = openTabs.get(activeTabPath);
                                tab.content = decoded;
                                if (cmInstance) cmInstance.setValue(decoded);
                                renderTabs();
                                toast('Historical version loaded into editor', 'info');
                            }
                        } catch (err) {
                            toast(`Failed to load version: ${err.message}`, 'error');
                        }
                    });
                });
            });
        } catch (err) {
            toast(`Failed to load history: ${err.message}`, 'error');
        }
    }

    // -------------------- Markdown preview --------------------
    function toggleMdPreview() {
        if (!activeTabPath) return;
        const tab = openTabs.get(activeTabPath);
        mdPreviewOn = !mdPreviewOn;
        if (mdPreviewOn) {
            editorWrapper.style.display = 'none';
            mdPreview.style.display = 'block';
            mdPreview.innerHTML = (typeof marked !== 'undefined') ? marked.parse(tab.content || '') : `<pre>${tab.content}</pre>`;
            mdPreviewBtn.classList.add('primary');
        } else {
            mdPreview.style.display = 'none';
            editorWrapper.style.display = 'flex';
            mdPreviewBtn.classList.remove('primary');
            setTimeout(() => cmInstance && cmInstance.refresh(), 10);
        }
    }

    // -------------------- Theme --------------------
    function applyTheme(theme) {
        currentTheme = theme;
        document.body.classList.toggle('light-theme', theme === 'light');
        if (cmInstance) cmInstance.setOption('theme', theme === 'dark' ? 'dracula' : 'default');
        localStorage.setItem('gh_fm_theme', theme);
    }
    function toggleTheme() {
        applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
    }

    // -------------------- Drag & drop upload --------------------
    let dragCounter = 0;
    document.addEventListener('dragenter', (e) => {
        if (!currentRepo) return;
        e.preventDefault();
        dragCounter++;
        dropZone.style.display = 'block';
        dropZone.classList.add('drag-over');
    });
    document.addEventListener('dragover', (e) => { if (currentRepo) e.preventDefault(); });
    document.addEventListener('dragleave', (e) => {
        if (!currentRepo) return;
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            dropZone.classList.remove('drag-over');
            dropZone.style.display = 'none';
        }
    });
    document.addEventListener('drop', async (e) => {
        if (!currentRepo) return;
        e.preventDefault();
        dragCounter = 0;
        dropZone.classList.remove('drag-over');
        dropZone.style.display = 'none';
        const files = Array.from(e.dataTransfer.files || []);
        for (const file of files) {
            await uploadFile(file);
        }
    });

    function readFileAsBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = reader.result;
                const base64 = result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    async function uploadFile(file) {
        try {
            const base64 = await readFileAsBase64(file);
            const path = file.name;
            let sha = null;
            try {
                const existing = await ghFetch(`/repos/${currentRepo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(currentBranch)}`);
                sha = existing.sha;
            } catch (e) { /* file doesn't exist yet */ }

            const body = { message: `Upload ${path}`, content: base64, branch: currentBranch };
            if (sha) body.sha = sha;

            await ghFetch(`/repos/${currentRepo}/contents/${encodeURIComponent(path)}`, {
                method: 'PUT',
                body: JSON.stringify(body)
            });
            toast(`Uploaded "${path}"`, 'success');
            fileTreeCache.clear();
            await loadRootTree();
        } catch (err) {
            toast(`Upload failed for "${file.name}": ${err.message}`, 'error');
        }
    }

    // -------------------- Keyboard shortcuts --------------------
    document.addEventListener('keydown', (e) => {
        const ctrlOrCmd = e.ctrlKey || e.metaKey;
        if (ctrlOrCmd && e.key.toLowerCase() === 's') {
            e.preventDefault();
            if (!saveFileBtn.disabled) saveFile();
        } else if (ctrlOrCmd && e.key.toLowerCase() === 'n') {
            e.preventDefault();
            if (!newFileBtn.disabled) newFile();
        } else if (ctrlOrCmd && e.key.toLowerCase() === 'w') {
            e.preventDefault();
            if (activeTabPath) closeTab(activeTabPath);
        }
    });

    // -------------------- Event listeners --------------------
    connectBtn.addEventListener('click', connect);
    disconnectBtn.addEventListener('click', disconnect);
    tokenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
    repoSelect.addEventListener('change', onRepoChange);
    branchSelect.addEventListener('change', onBranchChange);
    newFileBtn.addEventListener('click', newFile);
    newFolderBtn.addEventListener('click', newFolder);
    saveFileBtn.addEventListener('click', saveFile);
    deleteFileBtn.addEventListener('click', deleteActiveFile);
    copyContentBtn.addEventListener('click', copyContent);
    historyBtn.addEventListener('click', showHistory);
    mdPreviewBtn.addEventListener('click', toggleMdPreview);
    refreshTreeBtn.addEventListener('click', refreshTree);
    collapseAllBtn.addEventListener('click', collapseAll);
    themeToggle.addEventListener('click', toggleTheme);

    // -------------------- Init --------------------
    (function init() {
        const savedTheme = localStorage.getItem('gh_fm_theme');
        if (savedTheme) applyTheme(savedTheme);

        const savedToken = localStorage.getItem('gh_fm_token');
        if (savedToken) {
            tokenInput.value = savedToken;
            connect();
        }
    })();
})();
