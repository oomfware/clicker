import { nanoid } from 'nanoid';

const createPrefixedId = (prefix: string, size: number): string => `${prefix}${nanoid(size)}`;

export const createWorkspaceId = (): string => createPrefixedId('ws_', 6);
export const createSessionId = (): string => createPrefixedId('sess_', 8);
export const createConnectionId = (): string => createPrefixedId('conn_', 6);
export const createMessageId = (): string => createPrefixedId('msg_', 8);
