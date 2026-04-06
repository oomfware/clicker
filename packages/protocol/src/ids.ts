import { nanoid } from 'nanoid';

const createPrefixedId = (prefix: string, size: number): string => `${prefix}${nanoid(size)}`;

/*#__NO_SIDE_EFFECTS__*/
export const createWorkspaceId = (): string => createPrefixedId('ws_', 6);

/*#__NO_SIDE_EFFECTS__*/
export const createSessionId = (): string => createPrefixedId('sess_', 8);

/*#__NO_SIDE_EFFECTS__*/
export const createConnectionId = (): string => createPrefixedId('conn_', 6);

/*#__NO_SIDE_EFFECTS__*/
export const createMessageId = (): string => createPrefixedId('msg_', 8);
