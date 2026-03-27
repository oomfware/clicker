import { POPUP_PORT_NAME, parsePopupState, type PopupState } from '../../lib/popup-messages.ts';

const statusEl = document.getElementById('status')!;
// oxlint-disable-next-line no-unsafe-type-assertion -- known DOM element type
const nameInput = document.getElementById('name-input')! as HTMLInputElement;
const errorWarning = document.getElementById('error-warning')!;
const contentEl = document.getElementById('content')!;
// oxlint-disable-next-line no-unsafe-type-assertion -- known DOM element type
const createBtn = document.getElementById('create-btn')! as HTMLButtonElement;
// oxlint-disable-next-line no-unsafe-type-assertion -- known DOM element type
const createDialog = document.getElementById('create-dialog')! as HTMLDialogElement;
// oxlint-disable-next-line no-unsafe-type-assertion -- known DOM element type
const dialogNameInput = document.getElementById('dialog-name')! as HTMLInputElement;
const dialogCancel = document.getElementById('dialog-cancel')!;

let state: PopupState | undefined;
let activeTab: chrome.tabs.Tab | undefined;

const refreshActiveTab = () => {
	void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
		activeTab = tab;
		updateCreateButton();
	});
};

refreshActiveTab();
chrome.tabs.onActivated.addListener(refreshActiveTab);

const isActiveTabInWorkspace = (): boolean => {
	const tabId = activeTab?.id;
	if (!tabId || !state) return false;
	return state.workspaces.some((ws) => ws.tabs.some((t) => t.tabId === tabId));
};

const updateCreateButton = () => {
	createBtn.disabled = !activeTab?.id || isActiveTabInWorkspace();
};

const renderWorkspaces = (workspaces: PopupState['workspaces']) => {
	if (workspaces.length === 0) {
		contentEl.innerHTML = '<p class="empty">no workspaces</p>';
		return;
	}

	const ul = document.createElement('ul');
	ul.className = 'workspaces';

	for (const ws of workspaces) {
		const li = document.createElement('li');

		const name = document.createElement('span');
		name.textContent = ws.title;

		const count = document.createElement('span');
		count.className = 'tab-count';
		count.textContent = `${ws.tabs.length} tab${ws.tabs.length === 1 ? '' : 's'}`;

		li.append(name, count);
		ul.append(li);
	}

	contentEl.innerHTML = '';
	contentEl.append(ul);
};

const render = (s: PopupState) => {
	// don't overwrite name while the user is editing
	if (document.activeElement !== nameInput) {
		nameInput.value = s.name;
	}

	statusEl.classList.toggle('connected', s.connected);
	nameInput.classList.toggle('conflict', s.error === 'name_conflict');
	errorWarning.classList.toggle('visible', !!s.error);

	if (s.error === 'name_conflict') {
		errorWarning.textContent = 'Name already in use';
	} else if (s.error === 'version_mismatch') {
		errorWarning.textContent = 'Extension version incompatible with relay';
	} else {
		errorWarning.textContent = '';
	}

	renderWorkspaces(s.workspaces);
	updateCreateButton();
};

// state updates from background
const port = chrome.runtime.connect({ name: POPUP_PORT_NAME });
port.onMessage.addListener((raw) => {
	const parsed = parsePopupState(raw);
	if (!parsed) return;
	state = parsed;
	render(state);
});

// save name on enter or blur, but only if it actually changed
const saveName = () => {
	const name = nameInput.value.trim();
	if (!name || name === state?.name) return;
	void chrome.runtime.sendMessage({ type: 'popup:setName', name }).then((response) => {
		if (response && !response.ok) {
			nameInput.value = state?.name ?? '';
			nameInput.classList.add('error');
			setTimeout(() => nameInput.classList.remove('error'), 2000);
		}
	});
};

nameInput.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') {
		nameInput.blur();
	}
});
nameInput.addEventListener('blur', saveName);

// #region create workspace dialog

const getHostname = (url: string): string => {
	try {
		return new URL(url).hostname;
	} catch {
		return '';
	}
};

createBtn.addEventListener('click', () => {
	createDialog.returnValue = '';
	const suggestion = activeTab?.url ? getHostname(activeTab.url) : '';
	dialogNameInput.value = suggestion;
	createDialog.showModal();
	dialogNameInput.focus();
	dialogNameInput.select();
});

dialogCancel.addEventListener('click', () => {
	createDialog.close();
});

createDialog.addEventListener('close', () => {
	if (createDialog.returnValue !== 'submit') return;
	const name = dialogNameInput.value.trim();
	if (!name) return;
	createBtn.disabled = true;
	void chrome.runtime.sendMessage({ type: 'popup:createFromTab', name }).then((response) => {
		if (response && !response.ok) {
			console.error('failed to create workspace:', response.error);
		}
		updateCreateButton();
	});
});

// #endregion
