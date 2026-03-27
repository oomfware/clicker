import { defineConfig } from 'wxt';

export default defineConfig({
	manifest: {
		permissions: ['debugger', 'tabGroups', 'tabs', 'activeTab', 'storage'],
		host_permissions: ['<all_urls>'],
	},
});
