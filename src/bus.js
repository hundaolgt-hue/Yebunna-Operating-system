// One event bus for the whole server: state changes stream from here to the UI.
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(0);
