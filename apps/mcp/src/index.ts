#!/usr/bin/env node

import { command, constant, message, object, option, or, string } from '@optique/core';
import { withDefault } from '@optique/core/modifiers';
import { run } from '@optique/run';

const relayStartSchema = object({
	command: constant('relay start'),
	idleTimeout: withDefault(
		option('--idle-timeout', string(), {
			description: message`shut down after N seconds of inactivity`,
		}),
		'',
	),
});

const relayStopSchema = object({
	command: constant('relay stop'),
});

const relayParser = or(
	command('start', relayStartSchema, {
		description: message`start the relay server`,
	}),
	command('stop', relayStopSchema, {
		description: message`stop the relay server`,
	}),
);

const serveSchema = object({
	command: constant('serve'),
});

const parser = or(
	command('relay', relayParser, {
		description: message`manage the relay server`,
	}),
	command('serve', serveSchema, {
		description: message`start the MCP server (stdio transport)`,
	}),
);

const result = run(parser, {
	programName: 'clicker',
	help: 'both',
	brief: message`browser automation for AI agents`,
});

switch (result.command) {
	case 'relay start': {
		const { handler } = await import('./commands/relay-start.ts');
		handler(result);
		break;
	}
	case 'relay stop': {
		const { handler } = await import('./commands/relay-stop.ts');
		await handler();
		break;
	}
	case 'serve': {
		const { handler } = await import('./commands/serve.ts');
		await handler(result);
		break;
	}
}
