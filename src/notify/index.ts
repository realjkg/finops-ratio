// Public entry points of alert delivery (RFQ checklist item 2.5). Importing this
// module sends nothing: the dispatcher is disabled until a composition root
// supplies transports AND an egress flag that returns true. See README.md.

export * from './alertEvent';
export * from './circuitBreaker';
export * from './config';
export * from './dedupe';
export * from './deadLetters';
export * from './dispatcher';
export * from './email';
export * from './httpDelivery';
export * from './ip';
export * from './secrets';
export * from './slack';
export * from './ssrf';
export * from './system';
export * from './types';
export * from './webhook';
