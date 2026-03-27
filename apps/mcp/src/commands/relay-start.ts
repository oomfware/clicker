import { DEFAULT_PORT } from '@oomfware/clicker-protocol';

import { startRelay } from '../relay/server.ts';

interface RelayArgs {
	command: 'relay start';
	idleTimeout: string;
}

export const handler = (args: RelayArgs): void => {
	const port = Number(process.env.CLICKER_PORT) || DEFAULT_PORT;
	const relay = startRelay(port);

	const shutdown = () => {
		relay.close();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	const idleSeconds = args.idleTimeout ? Number(args.idleTimeout) : 0;
	if (idleSeconds > 0) {
		const idleMs = idleSeconds * 1_000;
		let idleTimer: ReturnType<typeof setTimeout> | null = null;

		const startIdle = () => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				console.log(`relay shutting down after ${idleSeconds}s of inactivity`);
				shutdown();
			}, idleMs);
		};

		// no connections at startup, start counting down
		startIdle();

		relay.onSessionChange((hasSessions) => {
			if (hasSessions) {
				if (idleTimer) {
					clearTimeout(idleTimer);
					idleTimer = null;
				}
			} else {
				startIdle();
			}
		});
	}
};
