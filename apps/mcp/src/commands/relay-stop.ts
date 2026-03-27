import { DEFAULT_PORT } from '@oomfware/clicker-protocol';

export const handler = async (): Promise<void> => {
	const port = Number(process.env.CLICKER_PORT) || DEFAULT_PORT;

	try {
		const res = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' });
		if (res.ok) {
			console.log('relay stopped');
		} else {
			console.error(`relay responded with ${res.status}`);
			process.exit(1);
		}
	} catch {
		console.error('relay is not running');
		process.exit(1);
	}
};
