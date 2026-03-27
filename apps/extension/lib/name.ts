const ADJECTIVES = [
	'amber',
	'bold',
	'calm',
	'coral',
	'deft',
	'fern',
	'gilt',
	'haze',
	'iron',
	'jade',
	'keen',
	'lush',
	'mint',
	'nova',
	'opal',
	'pale',
	'ruby',
	'sage',
	'teal',
	'vast',
	'warm',
	'zinc',
];

const NOUNS = [
	'anvil',
	'birch',
	'cedar',
	'dusk',
	'ember',
	'finch',
	'grove',
	'heron',
	'inlet',
	'junco',
	'knoll',
	'larch',
	'maple',
	'north',
	'otter',
	'pine',
	'ridge',
	'slate',
	'torch',
	'vale',
	'wren',
	'yarrow',
];

const NAME_KEY = 'clicker:name';
const CUSTOM_KEY = 'clicker:customName';

const generate = (): string => {
	const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
	const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
	return `${adj}-${noun}`;
};

/** returns the stored name, or generates and persists a random one */
export const getExtensionName = async (): Promise<string> => {
	const stored = await chrome.storage.local.get([NAME_KEY, CUSTOM_KEY]);
	// prefer user-set custom name, fall back to persisted generated name
	if (typeof stored[CUSTOM_KEY] === 'string') {
		return stored[CUSTOM_KEY];
	}
	if (typeof stored[NAME_KEY] === 'string') {
		return stored[NAME_KEY];
	}
	const name = generate();
	await chrome.storage.local.set({ [NAME_KEY]: name });
	return name;
};

/** persists a user-chosen custom name */
export const setExtensionName = async (name: string): Promise<void> => {
	await chrome.storage.local.set({ [CUSTOM_KEY]: name });
};

/** whether the current name was explicitly set by the user */
export const isCustomName = async (): Promise<boolean> => {
	const stored = await chrome.storage.local.get(CUSTOM_KEY);
	return typeof stored[CUSTOM_KEY] === 'string';
};

/** generates a new random name (different from the current one), persists it, and returns it */
export const regenerateName = async (): Promise<string> => {
	const current = await getExtensionName();
	let name: string;
	do {
		name = generate();
	} while (name === current);
	await chrome.storage.local.set({ [NAME_KEY]: name });
	await chrome.storage.local.remove(CUSTOM_KEY);
	return name;
};
